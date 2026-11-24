// Temporary: projects kept in the format before weapons stood free of their plate (9) are read once into the current
// one (10) in the garage of a browser, and kept so. It leaves, in a commit of its own, once the players have opened the
// game. Nothing else reads the old format.

// A project of the format 9 in the format 10: its guns no longer name the plate they fire through or stand on, which
// the core finds for itself; any other value as it is.
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
export function fromVersion9(project: unknown): unknown {
  if (!record(project) || project.version !== 9 || typeof project.preset !== 'string' || !Array.isArray(project.components)) return project;
  const components: unknown[] = project.components;
  return { ...project, version: 10, components: components.map(part => {
    if (!record(part) || part.kind !== 'weapon' || !record(part.mount) || !Object.hasOwn(part.mount, 'hostId')) return part;
    const { hostId: _hostId, ...mount } = part.mount;
    return { ...part, mount };
  }) };
}
