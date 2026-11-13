"""HTTP-API für den Editor.

Projekte liegen als Ordner unter DM_DATA_DIR/<projekt-id>/:
    inputs/       hochgeladene Videos, Fotos, Grundrisse
    scene.json    aktuelle Szene (Quelle der Wahrheit, der Editor baut daraus die 3D-Ansicht)
    status.json   Stand der Verarbeitung

Die Projekt-ID ist lang und zufällig und dient vorerst als Zugangsschlüssel (Teilen-Link).
Konten und Bezahlung kommen später über WordPress dazu.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import analysis
from .scene import CATALOG, Scene, demo_scene

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("diy-mamis")

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("DM_DATA_DIR", ROOT / "data" / "projects"))
WEB_DIST = Path(os.environ.get("DM_WEB_DIST", ROOT / "web" / "dist"))
MAX_UPLOAD_MB = int(os.environ.get("DM_MAX_UPLOAD_MB", "600"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("DM_ALLOWED_ORIGINS", "*").split(",") if o.strip()]
ALLOWED_EXT = analysis.VIDEO_EXT | analysis.IMAGE_EXT | {".pdf"}

DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="DIY Mamis 3D", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED_ORIGINS, allow_methods=["*"], allow_headers=["*"])

# --------------------------------------------------------------------------- Projekte


def project_dir(pid: str) -> Path:
    if not pid.isalnum() or len(pid) != 32:
        raise HTTPException(404, "Projekt nicht gefunden")
    path = DATA_DIR / pid
    if not path.exists():
        raise HTTPException(404, "Projekt nicht gefunden")
    return path


def read_status(path: Path) -> dict:
    f = path / "status.json"
    return json.loads(f.read_text()) if f.exists() else {}


def write_status(path: Path, **changes) -> dict:
    status = read_status(path) | changes | {"updated": time.time()}
    tmp = path / "status.json.tmp"
    tmp.write_text(json.dumps(status, ensure_ascii=False))
    tmp.replace(path / "status.json")
    return status


def save_scene(path: Path, scene: Scene) -> int:
    version = read_status(path).get("version", 0) + 1
    (path / "scene.json").write_text(scene.model_dump_json(indent=1), encoding="utf-8")
    write_status(path, version=version)
    return version


def project_payload(pid: str) -> dict:
    path = project_dir(pid)
    status = read_status(path)
    scene_file = path / "scene.json"
    payload = {
        "id": pid,
        "state": status.get("state", "unknown"),
        "step": status.get("step", ""),
        "error": status.get("error"),
        "version": status.get("version", 0),
        "scene": json.loads(scene_file.read_text()) if scene_file.exists() else None,
    }
    return payload


async def process_project(pid: str, kind: str, hint: str) -> None:
    path = DATA_DIR / pid
    try:
        if kind == "demo":
            scene = demo_scene()
        else:
            write_status(path, state="analyzing", step="KI analysiert den Raum")
            files = sorted((path / "inputs").iterdir())
            scene = await asyncio.to_thread(analysis.analyze, files, kind, hint)
        save_scene(path, scene)
        write_status(path, state="ready", step="")
    except Exception as exc:  # Fehler für den Nutzer sichtbar machen
        log.exception("Projekt %s fehlgeschlagen", pid)
        write_status(path, state="error", error=str(exc) or exc.__class__.__name__)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "analysis_available": analysis.available()}


@app.get("/api/catalog")
def catalog() -> dict:
    return CATALOG


@app.post("/api/projects")
async def create_project(
    kind: str = Form("video"),
    hint: str = Form(""),
    files: list[UploadFile] = File(default=[]),
) -> dict:
    if kind not in {"video", "photos", "floorplan", "demo"}:
        raise HTTPException(400, "Unbekannte Eingabeart")
    if kind != "demo":
        if not files:
            raise HTTPException(400, "Bitte mindestens eine Datei hochladen.")
        if not analysis.available():
            raise HTTPException(503, "Die KI-Analyse ist noch nicht eingerichtet (API-Key fehlt).")
    pid = uuid.uuid4().hex
    path = DATA_DIR / pid
    (path / "inputs").mkdir(parents=True)
    total = 0
    try:
        for k, upload in enumerate(files):
            ext = Path(upload.filename or "").suffix.lower()
            if ext not in ALLOWED_EXT:
                raise HTTPException(400, f"Dateityp {ext or '?'} wird nicht unterstützt.")
            target = path / "inputs" / f"{k:03d}{ext}"
            with target.open("wb") as out:
                while chunk := await upload.read(1024 * 1024):
                    total += len(chunk)
                    if total > MAX_UPLOAD_MB * 1024 * 1024:
                        raise HTTPException(413, f"Upload zu groß (maximal {MAX_UPLOAD_MB} MB).")
                    out.write(chunk)
    except HTTPException:
        shutil.rmtree(path, ignore_errors=True)
        raise
    write_status(path, state="queued", step="Wartet auf Verarbeitung", kind=kind, created=time.time())
    asyncio.create_task(process_project(pid, kind, hint))
    return {"id": pid}


@app.get("/api/projects/{pid}")
def get_project(pid: str) -> dict:
    return project_payload(pid)


@app.put("/api/projects/{pid}/scene")
async def update_scene(pid: str, scene: Scene) -> dict:
    path = project_dir(pid)
    try:
        scene = scene.normalized()
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    save_scene(path, scene)
    return project_payload(pid)


@app.get("/api/projects/{pid}/files/{name}")
def project_file(pid: str, name: str) -> FileResponse:
    if name != "scene.json":
        raise HTTPException(404)
    f = project_dir(pid) / name
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, headers={"Cache-Control": "no-cache"})


if WEB_DIST.exists():
    app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="editor")
