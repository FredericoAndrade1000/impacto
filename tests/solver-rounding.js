// Half one float32 ULP. Rapier converts mass/inertia to inverse properties,
// then multiplies an impulse and adds velocity; allow those two rounded
// operations for physical bodies only. Ballistic packets stay float64.
const halfUlp = value => 2 ** Math.max(-150, Math.floor(Math.log2(Math.abs(value) || Number.MIN_VALUE)) - 24);
export function solverMomentumRounding(body, origin = { x: 0, y: 0 }) {
  const center = body.massCenter || body, velocity = body.velocityAt(center), mass = body.mass,
    x = 2 * (mass * halfUlp(velocity.x) + Math.abs(velocity.x) * halfUlp(mass)),
    y = 2 * (mass * halfUlp(velocity.y) + Math.abs(velocity.y) * halfUlp(mass)),
    angular = 2 * (body.inertia * halfUlp(body.omega) + Math.abs(body.omega) * halfUlp(body.inertia)) +
      Math.abs(center.x - origin.x) * y + Math.abs(center.y - origin.y) * x + mass *
      (Math.abs(velocity.y) * halfUlp(center.x) + Math.abs(velocity.x) * halfUlp(center.y));
  return { x, y, angular };
}
