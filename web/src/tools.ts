/**
 * Werkzeuge und Kurzanleitungen für DIY-Projekte.
 * Werkzeuge mit Bild und Shop-Link kommen aus der Produktliste der Webseite
 * (Kategorie „Werkzeug“). Sie werden über die Stichwörter in `match` zugeordnet.
 */

export interface Tool {
  name: string;
  /** Wofür man es braucht, kurz */
  note?: string;
  /** Stichwörter im Produktnamen der Webseite (klein geschrieben) */
  match: string[];
}

export type ToolContext = 'moebel' | 'makeover' | 'regal' | 'farbe' | 'wand' | 'paneel';

/** Reihenfolge im Menü */
export const TOOL_ORDER: ToolContext[] = ['moebel', 'makeover', 'regal', 'farbe', 'wand', 'paneel'];

export interface ToolSet { title: string; tools: Tool[]; guide: string[] }

const T = {
  akkuschrauber: { name: 'Akkuschrauber', note: 'mit Bit-Set zum Zusammenbauen', match: ['akkuschrauber', 'akku-schrauber'] },
  akku: { name: 'Akku und Ladegerät', note: 'falls die Geräte ohne Akku kommen', match: ['akku-starter', 'starter-set', 'ladegerät'] },
  bits: { name: 'Bit-Set', match: ['bit-set', 'bitset', 'bits'] },
  bohrmaschine: { name: 'Bohrmaschine', note: 'Schlagbohrfunktion für Beton und Mauerwerk', match: ['bohrmaschine'] },
  bohrer: { name: 'Steinbohrer-Set', match: ['steinbohrer', 'bohrer-set', 'bohrerset', 'bohrer- und bit'] },
  duebel: { name: 'Dübel und Schrauben', note: 'passend zur Wand', match: ['dübel', 'duebel'] },
  leitungssucher: { name: 'Leitungssucher', note: 'vor dem Bohren Strom- und Wasserleitungen prüfen', match: ['leitungssucher', 'ortungsgerät', 'detektor'] },
  wasserwaage: { name: 'Wasserwaage', match: ['wasserwaage', 'kreuzlinienlaser', 'linienlaser'] },
  zollstock: { name: 'Zollstock oder Maßband', match: ['zollstock', 'maßband', 'massband', 'meterstab', 'entfernungsmesser'] },
  bleistift: { name: 'Bleistift', match: ['bleistift', 'zimmermannsbleistift'] },
  gummihammer: { name: 'Gummihammer', note: 'für Holzdübel und Steckverbindungen', match: ['gummihammer'] },
  inbus: { name: 'Inbusschlüssel', note: 'liegt bei Möbeln oft bei', match: ['inbus', 'innensechskant', 'sechskant'] },
  spruehgeraet: { name: 'Farbsprühgerät', note: 'oder Farbrolle mit Teleskopstiel', match: ['farbsprüh', 'sprühsystem', 'spruehgeraet', 'farbrolle', 'wagner'] },
  pinsel: { name: 'Pinsel', note: 'für Ecken und Kanten', match: ['pinsel'] },
  farbwanne: { name: 'Farbwanne mit Abstreifgitter', match: ['farbwanne', 'abstreifgitter'] },
  malerkrepp: { name: 'Malerkrepp', match: ['malerkrepp', 'kreppband', 'abdeckband'] },
  abdeckfolie: { name: 'Abdeckfolie oder Malervlies', match: ['abdeckfolie', 'malervlies', 'abdeckvlies'] },
  spachtel: { name: 'Spachtel und Füllmasse', note: 'für Löcher in der Wand', match: ['spachtel', 'füllmasse', 'moltofill'] },
  saege: { name: 'Stichsäge oder Handsäge', note: 'zum Zuschneiden', match: ['stichsäge', 'kreissäge', 'handsäge'] },
  schleifer: { name: 'Exzenterschleifer', note: 'Schnittkanten und alte Lackschichten anschleifen', match: ['exzenterschleifer'] },
  kreissaege: { name: 'Kreissäge', note: 'gerade Schnitte in Platten', match: ['kreissäge'] },
  stichsaege: { name: 'Stichsäge', note: 'Kurven und Ausschnitte', match: ['stichsäge'] },
  saegeblatt: { name: 'Sägeblätter', match: ['sägeblatt'] },
  winkelschleifer: { name: 'Winkelschleifer', note: 'Metall trennen, Rost und Lack entfernen', match: ['winkelschleifer'] },
  oberfraese: { name: 'Oberfräse', note: 'Kanten abrunden, Nuten fräsen', match: ['oberfräse'] },
  tacker: { name: 'Tacker', note: 'Stoff und Polster befestigen', match: ['tacker'] },
  schlagschrauber: { name: 'Schlagbohrschrauber', note: 'lange Schrauben in Hartholz', match: ['schlagbohrschrauber'] },
  bohrhammer: { name: 'Bohrhammer', note: 'große Löcher in Beton', match: ['bohrhammer'] },
  thermometer: { name: 'Infrarot-Thermometer', note: 'Oberflächentemperatur fürs Lackieren prüfen', match: ['thermometer'] },
  montagekleber: { name: 'Montagekleber', match: ['montagekleber', 'kleber'] },
  cutter: { name: 'Cuttermesser', match: ['cuttermesser', 'cutter', 'teppichmesser'] },
} satisfies Record<string, Tool>;

export const TOOL_SETS: Record<ToolContext, ToolSet> = {
  moebel: {
    title: 'Möbel aufbauen',
    tools: [T.akkuschrauber, T.akku, T.bits, T.inbus, T.gummihammer, T.zollstock, T.wasserwaage],
    guide: [
      'Teile auspacken und mit der Teileliste der Anleitung abgleichen. Schrauben nach Größe sortieren.',
      'Auf einer weichen Unterlage arbeiten (Karton oder Decke), damit nichts verkratzt.',
      'Grob vormontieren, Schrauben erst ganz anziehen, wenn alles sitzt. Den Akkuschrauber auf niedrigem Drehmoment nutzen.',
      'Holzdübel mit dem Gummihammer einklopfen, nicht mit einem Metallhammer.',
      'Am Platz mit der Wasserwaage ausrichten. Hohe Möbel mit dem beiliegenden Kippschutz an der Wand sichern.',
    ],
  },
  makeover: {
    title: 'Makeover',
    tools: [T.schleifer, T.kreissaege, T.stichsaege, T.saegeblatt, T.oberfraese, T.winkelschleifer, T.tacker, T.schlagschrauber, T.bohrhammer, T.thermometer],
    guide: [
      'Möbel ausräumen, Griffe und Beschläge abschrauben und beschriften.',
      'Oberfläche reinigen und mit dem Exzenterschleifer anschleifen (Körnung 120, danach 180). Staub gründlich entfernen.',
      'Neue Teile mit Kreis- oder Stichsäge zuschneiden, Kanten mit der Oberfräse abrunden.',
      'Grundieren, dann in dünnen Schichten lackieren. Die Oberflächentemperatur mit dem Thermometer prüfen.',
      'Bei Polstern den Stoff straff ziehen und von der Mitte nach außen festtackern.',
      'Beschläge wieder montieren, gut trocknen lassen und erst dann belasten.',
    ],
  },
  regal: {
    title: 'Regal aufbauen und befestigen',
    tools: [T.akkuschrauber, T.akku, T.bohrmaschine, T.bohrer, T.duebel, T.leitungssucher, T.wasserwaage, T.zollstock, T.bleistift],
    guide: [
      'Regal nach Anleitung zusammenbauen.',
      'Gewünschte Höhe messen und die Bohrlöcher mit Wasserwaage und Bleistift anzeichnen.',
      'Mit dem Leitungssucher prüfen, dass an der Stelle keine Leitungen verlaufen.',
      'Löcher bohren, Bohrstaub entfernen und die passenden Dübel einsetzen (Beton, Ziegel oder Gipskarton).',
      'Regal anschrauben, noch einmal waagerecht prüfen und erst dann beladen. Die maximale Last beachten.',
    ],
  },
  wand: {
    title: 'An die Wand hängen',
    tools: [T.bohrmaschine, T.bohrer, T.duebel, T.leitungssucher, T.wasserwaage, T.zollstock, T.bleistift],
    guide: [
      'Position festlegen: Bilder hängen meist mit der Mitte auf etwa 1,50 m Höhe.',
      'Aufhängepunkte mit Wasserwaage und Bleistift anzeichnen.',
      'Mit dem Leitungssucher die Stelle prüfen.',
      'Bohren, Dübel setzen und Haken oder Schraube eindrehen.',
      'Aufhängen und ausrichten.',
    ],
  },
  farbe: {
    title: 'Wände streichen',
    tools: [T.spruehgeraet, T.pinsel, T.farbwanne, T.malerkrepp, T.abdeckfolie, T.spachtel],
    guide: [
      'Möbel abrücken und abdecken, Boden mit Folie oder Vlies schützen.',
      'Löcher spachteln, trocknen lassen und glatt schleifen.',
      'Kanten, Fenster, Steckdosen und Sockelleisten mit Malerkrepp abkleben.',
      'Ecken und Kanten mit dem Pinsel vorstreichen.',
      'Fläche mit Sprühgerät oder Rolle gleichmäßig streichen, bei Bedarf nach dem Trocknen ein zweites Mal.',
      'Malerkrepp abziehen, solange die Farbe noch leicht feucht ist.',
    ],
  },
  paneel: {
    title: 'Paneele anbringen',
    tools: [T.saege, T.montagekleber, T.cutter, T.zollstock, T.wasserwaage, T.bleistift],
    guide: [
      'Wand säubern, sie muss trocken, glatt und tragfähig sein.',
      'Paneele ausmessen und anzeichnen, dann zuschneiden.',
      'Montagekleber in Schlangenlinien auf die Rückseite auftragen.',
      'Das erste Paneel mit der Wasserwaage exakt ausrichten und andrücken, die übrigen anschließen.',
      'Trocknen lassen, wie auf dem Kleber angegeben.',
    ],
  },
};

/** Alle passenden Produkte zum Werkzeug (Sägeblätter nur, wenn danach gesucht wird). */
export function findToolProducts<P extends { id: string; name: string }>(t: Tool, products: P[]): P[] {
  const out: P[] = [];
  for (const m of t.match) {
    for (const p of products) {
      const n = p.name.toLowerCase();
      if (!n.includes(m) || out.includes(p)) continue;
      if (/blatt|blätter/.test(n) && !/blatt/.test(m)) continue;
      out.push(p);
    }
  }
  return out;
}

/** Passendes Produkt aus der Produktliste zum Werkzeug (Zubehör wie Sägeblätter nur, wenn nichts anderes passt). */
export function findToolProduct<P extends { name: string }>(t: Tool, products: P[]): P | undefined {
  for (const m of t.match) {
    const hits = products.filter((x) => x.name.toLowerCase().includes(m));
    const p = hits.find((x) => !/blatt|blätter|zubehör/i.test(x.name)) ?? hits[0];
    if (p) return p;
  }
  return undefined;
}
