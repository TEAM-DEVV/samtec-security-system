import type { GhanaRegion } from '@samtec/contracts';

// `Record<GhanaRegion, …>` makes TypeScript fail the build if the contract
// ever changes the list of regions without this file following.
export const regionLabels: Record<GhanaRegion, string> = {
  AHAFO: 'Ahafo',
  ASHANTI: 'Ashanti',
  BONO: 'Bono',
  BONO_EAST: 'Bono East',
  CENTRAL: 'Central',
  EASTERN: 'Eastern',
  GREATER_ACCRA: 'Greater Accra',
  NORTH_EAST: 'North East',
  NORTHERN: 'Northern',
  OTI: 'Oti',
  SAVANNAH: 'Savannah',
  UPPER_EAST: 'Upper East',
  UPPER_WEST: 'Upper West',
  VOLTA: 'Volta',
  WESTERN: 'Western',
  WESTERN_NORTH: 'Western North',
};

/** Ghana's 16 regions, sorted by their label for drop-down lists. */
export const GHANA_REGIONS: readonly GhanaRegion[] = (
  Object.keys(regionLabels) as GhanaRegion[]
).sort((a, b) => regionLabels[a].localeCompare(regionLabels[b]));

export function isGhanaRegion(value: string): value is GhanaRegion {
  return GHANA_REGIONS.some((region) => region === value);
}
