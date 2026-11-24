// The gate consumes only the contact projection of an effect, not its rendering
// or wire payload. Other effects pass through without requiring contact fields.
export interface ContactSoundEvent {
  readonly type: string;
  readonly time?: number | undefined;
  readonly contactPair?: string | undefined;
  readonly id?: string | undefined;
  readonly source?: string | number | null | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly closingSpeed?: number | undefined;
  readonly impactEnergy?: number | undefined;
}
interface ContactHistory { lastSeen: number; lastAccepted: number; energy: number; speed: number; quiet?: boolean }
export class ContactSoundGate {
  readonly contacts = new Map<string, ContactHistory>();
  limit: number;
  constructor(limit = 256) { this.limit = limit; }
  clear(): void { this.contacts.clear(); }
  accepts(event: ContactSoundEvent, time = event.time || 0): boolean {
    const contact = event.type === 'ground' && event.contactPair;
    if (event.type !== 'debris' && !contact) return true;
    const identity = event.contactPair || event.id || event.source || `${Math.round(Number(event.x) * 4)}:${Math.round((event.y || 0) * 4)}`,
      key = event.type + ':' + identity,
      previous = this.contacts.get(key), gap = previous ? Math.max(0, time - previous.lastSeen) : Infinity,
      sinceAccepted = previous ? Math.max(0, time - previous.lastAccepted) : Infinity,
      fresh = !previous || gap > 0.65;
    const record: ContactHistory = previous || { lastSeen: time, lastAccepted: -Infinity, energy: 0, speed: 0 };
    // Keep lastSeen even for rejected contacts. Otherwise the physics event
    // throttle would become a periodic percussion timer on a static support.
    record.lastSeen = time; this.contacts.delete(key); this.contacts.set(key, record);
    while (this.contacts.size > this.limit) {
      const oldest = this.contacts.keys().next(); if (oldest.done) break;
      this.contacts.delete(oldest.value);
    }
    // Debris is a chip burst, not a mechanical contact. Only coalesce its bursts.
    if (!contact) return fresh;
    // Native terrain contacts carry both measures locally and over the network.
    const speed = Math.max(0, Number(event.closingSpeed)), energy = Math.max(0, Number(event.impactEnergy));
    const wasQuiet = record.quiet === true;
    if (speed < 0.045 || energy < 0.025 || speed < 0.14 && energy < 0.6) { record.quiet = true; return false; }
    const afterQuiet = wasQuiet && sinceAccepted >= 0.075 && speed >= 0.22 && energy >= 0.6,
      surge = sinceAccepted > 0.13 && (speed > record.speed * 1.8 + 0.16 || energy > record.energy * 2.4 + 0.6) && (!wasQuiet || speed >= 0.22),
      accepted = fresh || afterQuiet || surge;
    if (accepted) { record.lastAccepted = time; record.energy = energy; record.speed = speed; record.quiet = false; }
    return accepted;
  }
}
