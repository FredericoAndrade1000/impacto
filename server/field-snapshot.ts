// A field written out whole, and taken back as it was to the last bit (field-host.ts): the core's world as the core
// writes it (`NativeWorld.export_state`), and every object the room and the publication of its host hold, each once
// however many hold it, with what it is an instance of and the order of its fields. What a field is not the one to
// hold is not written but named, and found again in the room that takes the field back: the core itself, the ground,
// the sites of the ground and the materials, and what the room draws with and places bases by.
// A map a field keeps by objects it does not own the keys of lets go of them by itself, and cannot be read through:
// the one it keeps — which handle of the core stands for each part — is worked out again from the parts.
import { SharedRoom, Side } from './room.ts';
import { GuardianSide } from './airdrop-guardian.ts';
import { Publication } from './publication.ts';
import { Fog } from './fog.ts';
import { BaseWatch } from './base-watch.ts';
import { SupplyDispatch } from './supply-dispatch.ts';
import { Works } from './field-construction.ts';
import { Roadworks } from './road-works.ts';
import { World } from '../src/physics.ts';
import { RustGame, NativeQueries } from '../src/rust-game.ts';
import { NativeDynamics } from '../src/native-dynamics.ts';
import { PlateMesh } from '../src/mesh.ts';
import { DamageRegions } from '../src/damage-regions.ts';
import { Vehicle } from '../src/vehicle.ts';
import { Random } from '../src/math.ts';
import { GroundSight } from '../src/ground-sight.ts';
import { Squad } from '../src/squad.ts';
import { keyOf } from '../src/network-protocol.ts';
import { normalRoads } from '../src/roads.ts';

const CLASSES = { SharedRoom, Side, GuardianSide, Publication, Fog, BaseWatch, SupplyDispatch, Works, Roadworks, World, RustGame, NativeQueries, NativeDynamics, PlateMesh, DamageRegions,
  Vehicle, Random, GroundSight, Squad };
type ClassName = keyof typeof CLASSES;
const NAMES = new Map<object, ClassName>(Object.entries(CLASSES).map(([name, type]) => [type.prototype, name as ClassName]));
const MADE: Partial<Record<ClassName, () => object>> = { Fog: () => new Fog(), BaseWatch: () => new BaseWatch(), World: () => new World(null) };
const SPECIAL = { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 };
const TYPED = { Float32Array, Float64Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Uint8ClampedArray };
type TypedName = keyof typeof TYPED;
type Word = string | number | boolean | null | [number] | { n: keyof typeof SPECIAL } | { u: 0 } | { b: string };
type Entry = ['x', string] | ['a', Word[]] | ['m', [Word, Word][]] | ['s', Word[]] | ['w'] |
  ['t', TypedName, string] | ['o', ClassName | null, (number | Word)[], 1?];
export interface FieldSnapshot { core: string; heap: { keys: string[]; entries: Entry[] } }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function wordShape(value: unknown): value is Word {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.length === 1 && Number.isSafeInteger(value[0]) && value[0] >= 0;
  return record(value) && Object.keys(value).length === 1 && (typeof value.n === 'string' && Object.hasOwn(SPECIAL, value.n) || value.u === 0 || typeof value.b === 'string');
}
function entryShape(value: unknown): value is Entry {
  if (!Array.isArray(value)) return false;
  switch (value[0]) {
    case 'x': return typeof value[1] === 'string';
    case 'a': case 's': return Array.isArray(value[1]) && value[1].every(wordShape);
    case 'm': return Array.isArray(value[1]) && value[1].every((pair: unknown) => Array.isArray(pair) && pair.length === 2 && pair.every(wordShape));
    case 'w': return true;
    case 't': return typeof value[1] === 'string' && Object.hasOwn(TYPED, value[1]) && typeof value[2] === 'string';
    case 'o': return (value[1] === null || typeof value[1] === 'string' && Object.hasOwn(CLASSES, value[1])) &&
      Array.isArray(value[2]) && value[2].length % 2 === 0 && value[2].every((word: unknown, index: number) => index % 2 ? wordShape(word) : Number.isSafeInteger(word) && typeof word === 'number' && word >= 0) &&
      (value[3] === undefined || value[3] === 1);
    default: return false;
  }
}
export function isFieldSnapshot(value: unknown): value is FieldSnapshot {
  return record(value) && typeof value.core === 'string' && record(value.heap) && Array.isArray(value.heap.keys) &&
    value.heap.keys.every((key: unknown) => typeof key === 'string') && Array.isArray(value.heap.entries) && value.heap.entries.every(entryShape);
}
function named(room: SharedRoom): Map<object, string> {
  const names = new Map<object, string>([[room.field.dynamics!.core, 'core'], [room.field.terrain, 'terrain'], [room.field.materials, 'materials'],
    [room.random, 'random'], [room.sites, 'sites'], ...[...room.sites].map(([id, site]): [object, string] => [site, `site:${id}`])]);
  if (room.site) names.set(room.site, 'site');
  return names;
}
// What of the room's objects a field written out keeps, and how (replay-recording.ts keeps less than the whole).
export interface FieldProjection {
  keys(object: object): readonly string[];
  value(object: object, key: string, value: unknown): unknown;
}
export function writeField(room: SharedRoom, publication: Publication, projection?: FieldProjection): FieldSnapshot {
  const heap = writeHeap(room, publication, projection), native = room.field.dynamics!.core;
  if (!native.export_state) throw new Error('Este núcleo não grava fotos binárias do campo.');
  return { core: Buffer.from(native.export_state()).toString('base64'), heap };
}
export function readField(room: SharedRoom, input: unknown): Publication {
  if (!isFieldSnapshot(input)) throw new Error('Foto do campo inválida.');
  const native = room.field.dynamics!.core;
  if (!native.import_state) throw new Error('Este núcleo não retoma fotos binárias do campo.');
  native.import_state(Buffer.from(input.core, 'base64'));
  return readHeap(room, input.heap);
}
// The field of one room made the field of another on the same ground, as readField(to, writeField(from, …)) would make
// it, without writing the core's world out and reading it back: the replay's render copies, several a second.
export function copyField(from: SharedRoom, publication: Publication, to: SharedRoom, projection?: FieldProjection): Publication {
  const heap = writeHeap(from, publication, projection), native = to.field.dynamics!.core;
  if (!native.copy_from) throw new Error('Este núcleo não copia o campo.');
  native.copy_from(from.field.dynamics!.core);
  return readHeap(to, heap);
}
// Object references, property order and prototypes remain exactly the snapshot's graph.
function writeHeap(room: SharedRoom, publication: Publication, projection?: FieldProjection): FieldSnapshot['heap'] {
  const world = room.field, game = world.rustGame!;
  for (const part of [...world.plates, ...world.modules])
    if (game.objects.get(game.objectHandles.get(part)!) !== part) throw new Error(`a peça ${part.id} não é a que o núcleo tem por ela`);
  const names = named(room), ids = new Map<object, number>(), objects: object[] = [], keys = new Map<string, number>(), entries: Entry[] = [], seats = new Set<object>(room.players.values());
  const key = (name: string): number => keys.get(name) ?? keys.set(name, keys.size).get(name)!;
  const word = (value: unknown): Word => {
    switch (typeof value) {
      case 'number': return Number.isFinite(value) && !Object.is(value, -0) ? value : { n: Object.is(value, -0) ? '-0' : Number.isNaN(value) ? 'NaN' : value < 0 ? '-Infinity' : 'Infinity' };
      case 'string': case 'boolean': return value;
      case 'undefined': return { u: 0 };
      case 'bigint': return { b: String(value) };
      case 'object': case 'function': {
        if (value === null) return null;
        let id = ids.get(value);
        if (id === undefined) { ids.set(value, id = objects.length); objects.push(value); }
        return [id];
      }
      default: throw new Error(`um valor que não se escreve (${typeof value})`);
    }
  };
  word(room); word(publication);
  for (let i = 0; i < objects.length; i++) {
    const object = objects[i]!, name = names.get(object);
    if (name !== undefined) entries.push(['x', name]);
    else if (typeof object === 'function') throw new Error(`uma função que não se escreve (${object.name || 'sem nome'})`);
    else if (Array.isArray(object)) entries.push(['a', Array.from(object, word)]);
    else if (object instanceof Map) entries.push(['m', [...object].map(([k, v]): [Word, Word] => [word(k), word(v)])]);
    else if (object instanceof Set) entries.push(['s', [...object].map(word)]);
    else if (object instanceof WeakMap) entries.push(['w']);
    else if (ArrayBuffer.isView(object)) {
      const type = object.constructor.name;
      if (!Object.hasOwn(TYPED, type)) throw new Error(`um vetor que não se escreve (${type})`);
      entries.push(['t', type as TypedName, Buffer.from(object.buffer, object.byteOffset, object.byteLength).toString('base64')]);
    } else {
      const proto: unknown = Object.getPrototypeOf(object), type = proto === Object.prototype ? null : typeof proto === 'object' && proto !== null ? NAMES.get(proto) : undefined;
      if (type === undefined) throw new Error('um objeto de um tipo que não se escreve');
      const fields: (number | Word)[] = [];
      for (const name of projection?.keys(object) ?? Object.keys(object)) {
        const value = seats.has(object) && name === 'token' ? keyOf(Reflect.get(object, 'id')) : Reflect.get(object, name);
        fields.push(key(name), word(projection ? projection.value(object, name, value) : value));
      }
      entries.push(Object.isFrozen(object) ? ['o', type, fields, 1] : ['o', type, fields]);
    }
  }
  return { keys: [...keys.keys()], entries };
}
function readHeap(room: SharedRoom, { keys, entries }: FieldSnapshot['heap']): Publication {
  const by = new Map([...named(room)].map(([object, name]) => [name, object]));
  const objects: object[] = entries.map((entry, i): object => {
    switch (entry[0]) {
      case 'x': { const value = by.get(entry[1]); if (!value) throw new Error(`este campo não tem ${entry[1]}`); return value; }
      case 'a': return [];
      case 'm': return new Map<unknown, unknown>();
      case 's': return new Set<unknown>();
      case 'w': return new WeakMap<object, unknown>();
      case 't': { const bytes = Buffer.from(entry[2], 'base64'), type = TYPED[entry[1]]; return new type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); }
      case 'o': {
        if (i === 0) return room;
        if (entry[1] === null) return {};
        const made = MADE[entry[1]];
        const value: object = made ? made() : Object.create(CLASSES[entry[1]].prototype);
        return value;
      }
    }
  });
  const value = (word: Word): unknown => {
    if (Array.isArray(word)) { const object = objects[word[0]]; if (!object) throw new Error('Referência inválida na foto do campo.'); return object; }
    if (word === null || typeof word !== 'object') return word;
    return 'n' in word ? SPECIAL[word.n] : 'u' in word ? undefined : BigInt(word.b);
  };
  entries.forEach((entry, i) => {
    const object = objects[i]!;
    if (entry[0] === 'a' && Array.isArray(object)) for (const word of entry[1]) object.push(value(word));
    else if (entry[0] === 'm' && object instanceof Map) for (const [k, v] of entry[1]) object.set(value(k), value(v));
    else if (entry[0] === 's' && object instanceof Set) for (const word of entry[1]) object.add(value(word));
    else if (entry[0] === 'o') {
      const fields = entry[2];
      for (let j = 0; j < fields.length; j += 2) {
        const index = fields[j], word = fields[j + 1];
        if (typeof index !== 'number' || keys[index] === undefined || word === undefined) throw new Error('Campo inválido na foto do campo.');
        Reflect.set(object, keys[index]!, value(word));
      }
      if (entry[3]) Object.freeze(object);
    }
  });
  const game = room.field.rustGame!;
  game.objectHandles = new WeakMap([...game.objects].map(([handle, object]) => [object, handle]));
  room.field.lay(normalRoads(room.field.roads));
  const publication = objects[1];
  if (!(publication instanceof Publication)) throw new Error('Publicação inválida na foto do campo.');
  return publication;
}
