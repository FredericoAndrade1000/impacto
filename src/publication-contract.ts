import type { SceneActorSnapshot, ScenePlate, SceneModule, SceneSnapshot, GroundContact, SuspensionState } from './scene-contract.ts';

type UnreadModule = 'owner' | 'physicalMass' | 'dryMass' | 'physicalInertia' | 'physicalCenterLocal' | 'mechanicalDepth' |
  'barrelProfile' | 'receiverMm' | 'barrelMm' | 'burnAge' | 'smokeClock' | 'fireAge' | 'barrelDamage' | 'ballisticScars' |
  'fuelLitres' | 'capacityRounds' | 'roundMass' | 'aimOffset' | 'targetAimOffset' | 'wheelAngularSpeed';
type ModulePublication<T> = T extends SceneModule ? Omit<T, UnreadModule | 'suspension' | 'groundContact'> & {
  suspension?: Pick<SuspensionState, 'displacement'>;
  groundContact?: Pick<GroundContact, 'x'> | null;
} : never;
export type PublishedModule = ModulePublication<SceneModule>;
export type PublishedDefinition = Omit<ScenePlate['definition'], 'owner' | 'actorId' | 'mountId' | 'ballisticGrid' |
  'originalArea' | 'physicalMass' | 'physicalInertia' | 'physicalCenterLocal' | 'dragWidthM'>;
export type PublishedPlate = Omit<ScenePlate, 'definition' | 'ballisticGrid' | 'ballisticScars' | 'physicalMass' |
  'physicalInertia' | 'physicalCenterLocal'> & { definition: PublishedDefinition };
export type PublishedVehicle = Omit<NonNullable<SceneActorSnapshot['vehicle']>, 'enabled' | 'massTonnes' | 'powerPerTonne' |
  'travel' | 'groundSlope' | 'groundSurface' | 'groundGrip' | 'groundLoad' | 'groundPressureKPa' | 'groundResistance' |
  'softGroundLoad' | 'lastImpulse' | 'peakImpulse' | 'station'>;
export type PublishedActor = Omit<SceneActorSnapshot, 'aim' | 'weapon' | 'stats' | 'contactContours' | 'vehicle'> & {
  vehicle?: PublishedVehicle | null;
};
export type PublishedScene = Omit<SceneSnapshot, 'tick' | 'actors' | 'plates' | 'modules'> & {
  actors: PublishedActor[]; plates: PublishedPlate[]; modules: PublishedModule[];
};
