export interface MissionIntegrationInput {
  missionId: string;
  workItemId: string;
  integrationId: string;
  candidateHash: string;
  verifierEvidenceHash: string;
}

export interface MissionIntegrationResult {
  integrationId: string;
  integratedHash: string;
}

export interface MissionIntegrationAdapter {
  integrate(input: MissionIntegrationInput): Promise<MissionIntegrationResult>;
  recover(input: MissionIntegrationInput): Promise<MissionIntegrationResult | null>;
}
