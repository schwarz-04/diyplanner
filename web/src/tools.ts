/**
 * Werkzeuge für DIY-Projekte. Diese Liste ist bewusst einfach gehalten und
 * lässt sich durch die Werkzeugliste von DIY Mamis ersetzen.
 */

export interface Tool {
  name: string;
  /** Wofür man es braucht, kurz */
  note?: string;
  /** Optionaler Shop-Link (Affiliate) */
  url?: string;
}

export type ToolContext = 'moebel' | 'regal' | 'wand' | 'farbe' | 'paneel';

const T = {
  akkuschrauber: { name: 'Akkuschrauber', note: 'mit Bit-Set zum Zusammenbauen' },
  bohrmaschine: { name: 'Bohrmaschine', note: 'Schlagbohrfunktion für Beton und Mauerwerk' },
  duebel: { name: 'Dübel und Schrauben', note: 'passend zur Wand' },
  leitungssucher: { name: 'Leitungssucher', note: 'vor dem Bohren Strom- und Wasserleitungen prüfen' },
  wasserwaage: { name: 'Wasserwaage' },
  zollstock: { name: 'Zollstock oder Maßband' },
  bleistift: { name: 'Bleistift' },
  gummihammer: { name: 'Gummihammer', note: 'für Holzdübel und Steckverbindungen' },
  inbus: { name: 'Inbusschlüssel', note: 'liegt bei Möbeln oft bei' },
  spruehgeraet: { name: 'Farbsprühgerät', note: 'oder Farbrolle mit Teleskopstiel' },
  pinsel: { name: 'Pinsel', note: 'für Ecken und Kanten' },
  farbwanne: { name: 'Farbwanne mit Abstreifgitter' },
  malerkrepp: { name: 'Malerkrepp' },
  abdeckfolie: { name: 'Abdeckfolie oder Malervlies' },
  spachtel: { name: 'Spachtel und Füllmasse', note: 'für Löcher in der Wand' },
  stichsaege: { name: 'Stichsäge oder Handsäge', note: 'zum Zuschneiden' },
  montagekleber: { name: 'Montagekleber' },
  cuttermesser: { name: 'Cuttermesser' },
} satisfies Record<string, Tool>;

export const TOOL_SETS: Record<ToolContext, { title: string; tools: Tool[] }> = {
  moebel: { title: 'Möbel aufbauen', tools: [T.akkuschrauber, T.inbus, T.gummihammer, T.zollstock, T.wasserwaage] },
  regal: { title: 'Regal aufbauen und befestigen', tools: [T.akkuschrauber, T.bohrmaschine, T.duebel, T.leitungssucher, T.wasserwaage, T.zollstock, T.bleistift] },
  wand: { title: 'An die Wand hängen', tools: [T.bohrmaschine, T.duebel, T.leitungssucher, T.wasserwaage, T.zollstock, T.bleistift] },
  farbe: { title: 'Wand streichen', tools: [T.spruehgeraet, T.pinsel, T.farbwanne, T.malerkrepp, T.abdeckfolie, T.spachtel] },
  paneel: { title: 'Paneele anbringen', tools: [T.stichsaege, T.montagekleber, T.cuttermesser, T.zollstock, T.wasserwaage, T.bleistift] },
};
