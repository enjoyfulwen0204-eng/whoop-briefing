import {BODY_ENERGY as C,BODY_ENERGY_CONSTANTS_HASH} from './bodyEnergyRegistry.js';

/** Adopted engineering-estimate criteria, not newly inferred clinical cutoffs. */
export const BODY_ENERGY_RELEASE_CRITERIA=Object.freeze({
  version:'body-energy-release-criteria-v1',
  documentVersion:'phase4-adr-v1-stage5-consolidated-closure',
  publicationSource:'docs/phase4-architecture.md:556-571',
  qualitySource:'docs/phase4-architecture.md:299-318,442-481',
  interpretationSource:'docs/phase4-architecture.md:232-259',
  algorithm:C.algorithm,constants:C.constants,constantsHash:BODY_ENERGY_CONSTANTS_HASH,
  publicationQuality:'AVAILABLE',confidenceMinimum:0.80,freshMaximumMs:C.freshMinutes*60000,
  baselineTarget:C.baselineTarget,baselineLookbackDays:C.baselineLookback,
  requiredAnalyses:Object.freeze(['nonProductionShadowCalibration','candidateInputCorrelation','inputAndDomainAblation',
    'coefficientAndBoundarySensitivity','scoreDistributionAndRangeUse','missingnessAndQuality',
    'duplicateSourceDominance']),
  requiredApprovals:Object.freeze(['architectureOwner','independentFinalGate','productPrivacyStatisticalWordingAndConstants']),
  clinicalGroundTruthRequired:false,
  clinicalGroundTruthNote:'ADR supplies an OS-authored engineering estimate; no medical accuracy or official WHOOP-score agreement claim is authorized.',
  empiricalNumericCutoffs:null,
  empiricalCutoffNote:'No population correlation/distribution acceptance cutoff is adopted. Complete analyses and limitations require actual independent qualification, not an invented automatic cutoff.',
});

/** Software/analysis completion is deliberately distinct from publication
 * approval. This validates a review packet; it cannot issue a capability. */
export function validateBodyEnergyQualificationPacket(packet) {
  const reasons=[];
  if(!packet||packet.criteriaVersion!==BODY_ENERGY_RELEASE_CRITERIA.version
    ||packet.algorithm!==C.algorithm||packet.constantsHash!==BODY_ENERGY_CONSTANTS_HASH)reasons.push('VERSION_MISMATCH');
  if(packet?.executionEnvironment!=='NON_PRODUCTION')reasons.push('NON_PRODUCTION_CALIBRATION_REQUIRED');
  if(packet?.dataDeclaration!=='GENUINE_AUTHORIZED_RETAINED_INPUTS')reasons.push('GENUINE_INPUT_EVIDENCE_REQUIRED');
  for(const name of BODY_ENERGY_RELEASE_CRITERIA.requiredAnalyses)
    if(packet?.analyses?.[name]?.status!=='REVIEWED_ACCEPTABLE'
      ||!/^[a-f0-9]{64}$/.test(packet?.analyses?.[name]?.evidenceSha256??''))reasons.push(`ANALYSIS_PENDING:${name}`);
  for(const name of BODY_ENERGY_RELEASE_CRITERIA.requiredApprovals)
    if(packet?.approvals?.[name]?.status!=='PASS'
      ||!/^[a-f0-9]{64}$/.test(packet?.approvals?.[name]?.evidenceSha256??''))reasons.push(`APPROVAL_PENDING:${name}`);
  if(packet?.authorityScope!=='CONTROLLED_ENGINEERING_ESTIMATE_PUBLICATION'
    ||packet?.medicalOrOfficialWhoopClaim!==false)reasons.push('ESTIMATE_AUTHORITY_REQUIRED');
  return Object.freeze({complete:reasons.length===0,reasons:Object.freeze(reasons)});
}
