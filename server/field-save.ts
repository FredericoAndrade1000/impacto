// The field kept on disk for the server that starts next. One file, written whole beside the one
// before and put in its place only then: a server stopped while it writes leaves the previous one.
// What a room keeps of itself is the room's own to say (SharedRoom.keep); here it is given a
// number and a place. A file that cannot be resumed stays in place and opening fails; it never substitutes
// another field. This JSON is admitted again from its designs;
// it is not a binary snapshot of a core, whose contract belongs to the diary (field-host.ts).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { createHash } from 'node:crypto';

// Raised by hand when what a room keeps of itself changes its shape or its meaning.
export const FIELD_SAVE = 32;
const LEGACY_SAVE = 31, PRE_DUEL_SAVE = 30, PRE_COMMANDER_SAVE = 29;
const NAME = 'field.json';
// Concrete field artifacts prove this directory is not a fresh world. Diagnostic logs do not.
// Presence is enough: no checkpoint, temporary file, archived field or diary is repaired or converted here.
const FIELD_ARTIFACT = /^(?:field\.json(?:\.\d+\.\d+\.tmp)?|field\.unreadable\.\d{8}T\d{6}Z(?:-\d+)?\.json|field\.before-(?:commanders-save29|duel-save30|economy-save31)-[0-9a-f]{12}\.json|replays)$/;

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
type FieldEnvelope = { save: typeof FIELD_SAVE | typeof LEGACY_SAVE | typeof PRE_DUEL_SAVE | typeof PRE_COMMANDER_SAVE; room: Record<string, unknown>; at: unknown };
function envelope(value: unknown): FieldEnvelope {
  if (!record(value) || value.save !== FIELD_SAVE && value.save !== LEGACY_SAVE && value.save !== PRE_DUEL_SAVE && value.save !== PRE_COMMANDER_SAVE) throw new Error('O campo salvo é de outra versão do jogo.');
  if (!record(value.room)) throw new Error('O arquivo salvo não contém o estado do campo.');
  // Older tags cannot hide rules that their readers would silently discard:
  // 29 has no controllers, and 30 has no definitive duel result.
  if (value.save === PRE_COMMANDER_SAVE && Object.hasOwn(value.room, 'commanders')) throw new Error('Controladores exigem o formato atual do campo salvo.');
  if (value.save < 31 && Object.hasOwn(value.room, 'duel')) throw new Error('Duelos exigem o formato atual do campo salvo.');
  if (value.save !== FIELD_SAVE && Array.isArray(value.room.commanders) && value.room.commanders.some(row =>
    Array.isArray(row) && record(row[1]) && Object.hasOwn(row[1], 'deferredRepairs')))
    throw new Error('Reparos adiados pelo comandante exigem o formato atual do campo salvo.');
  // The date is diagnostic metadata. Older valid fields may omit it or use their own label.
  return { save: value.save, room: value.room, at: value.at };
}

// The field kept in a directory. The token of each seat is in it: the file is its owner's alone to read.
export function fieldStore(dir: string) {
  const file = join(dir, NAME), fresh = join(dir, `${NAME}.${process.pid}.${threadId}.tmp`), failed = new Set<string>();
  let checked = false, legacy: { text: string; save: typeof LEGACY_SAVE | typeof PRE_DUEL_SAVE | typeof PRE_COMMANDER_SAVE } | null = null;
  const source = (text: string): FieldEnvelope => {
    const kept = envelope(JSON.parse(text));
    legacy = kept.save === FIELD_SAVE ? null : { text, save: kept.save }; checked = true;
    return kept;
  };
  const backupLegacy = () => {
    if (legacy === null) return;
    const hash = createHash('sha256').update(legacy.text).digest('hex').slice(0, 12),
      prefix = legacy.save === PRE_COMMANDER_SAVE ? 'commanders-save29' : legacy.save === PRE_DUEL_SAVE ? 'duel-save30' : 'economy-save31',
      backup = join(dir, `field.before-${prefix}-${hash}.json`);
    try { writeFileSync(backup, legacy.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (!record(error) || error.code !== 'EEXIST' || readFileSync(backup, 'utf8') !== legacy.text) throw error;
    }
  };
  mkdirSync(dir, { recursive: true });
  return {
    // Only a new directory with no field artifacts may open a new field. Every refusal preserves the original bytes.
    open<Room>(make: (kept: Record<string, unknown> | null) => Room): Room {
      let text;
      try { text = readFileSync(file, 'utf8'); }
      catch (error) {
        if (!record(error) || error.code !== 'ENOENT') throw error;
        if (readdirSync(dir).some(name => FIELD_ARTIFACT.test(name)))
          throw new Error('Campo salvo ausente, mas há dados do campo preservados nesta pasta.');
        checked = true; legacy = null;
        return make(null);
      }
      const kept = source(text);
      const room = make(kept.room);
      console.log(`Campo retomado como estava em ${kept.at}.`);
      return room;
    },
    // Writes what a field keeps of itself (`field.keep()`: a room, or the host that runs it, field-host.ts).
    // A field that cannot be written goes on as it was, and so does the file: each reason is said once.
    save(field: { keep(): unknown }): boolean {
      try {
        const room = field.keep();
        if (!record(room)) throw new Error('O campo não produziu um estado para gravar.');
        if (!checked) {
          try { source(readFileSync(file, 'utf8')); }
          catch (error) { if (!record(error) || error.code !== 'ENOENT') throw error; checked = true; }
        }
        const kept: FieldEnvelope = { save: FIELD_SAVE, at: new Date().toISOString(), room }, text = JSON.stringify(kept),
          handle = openSync(fresh, 'w', 0o600);
        try { writeFileSync(handle, text); fsyncSync(handle); } finally { closeSync(handle); }
        backupLegacy();
        renameSync(fresh, file);
        legacy = null;
        failed.clear();
        return true;
      } catch (error) {
        const message = record(error) && typeof error.message === 'string' ? error.message :
          typeof error === 'string' ? error : 'Falha desconhecida ao gravar o campo.';
        if (!failed.has(message)) { failed.add(message); console.error('Campo não salvo:', message); }
        return false;
      }
    },
  };
}
