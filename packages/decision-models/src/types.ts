/** A provider-independent, versioned decision request. Product policy stays with the caller. */
export type DecisionState = string | Record<string, unknown> | unknown[];

export type DecisionChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

export type DecisionBinaryQuestion = {
  type: 'binary';
  instructions: string;
  criteria?: { true: string; false: string };
};

export type DecisionOrdinalQuestion = {
  type: 'ordinal';
  instructions: string;
  /** Stable, zero-based levels in ascending order. */
  criteria: string[];
};

export type DecisionQuestion = DecisionChoiceQuestion | DecisionBinaryQuestion | DecisionOrdinalQuestion;

export type DecisionChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export type DecisionBinaryAnswer = { type: 'binary'; probability: number };

export type DecisionOrdinalAnswer = {
  type: 'ordinal';
  /** Expected level index, which can fall between levels. */
  score: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export type DecisionAnswer = DecisionChoiceAnswer | DecisionBinaryAnswer | DecisionOrdinalAnswer;
export type DecisionProbabilitySemantics = 'model_probability' | 'relative_probability' | 'uncalibrated_score' | 'unavailable';

export type DecisionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  /** Actual transport request count, not the number of evaluated questions. */
  requests: number;
};

export type DecisionResult = {
  answers: Record<string, DecisionAnswer>;
  model: string;
  providerId: string;
  latencyMs: number;
  usage?: DecisionUsage;
  adapterVersion: string;
  probabilitySemantics: DecisionProbabilitySemantics;
  /** Provider documentation, not evidence of calibration on the application's data. */
  calibrationReference?: string;
};

export type DecisionProviderConfiguration = {
  providerId: string;
  model: string;
  /** Compatible providers accept a base URL or the complete /v1/systemone endpoint. */
  endpoint?: string;
  /** An explicit, trusted administrator configuration is needed for local/private endpoints. */
  allowPrivateNetwork?: boolean;
};

export type DecisionCredential = { apiKey?: string };

export type DecisionInput = {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  schemaVersion: string;
  configuration: DecisionProviderConfiguration;
  credential?: DecisionCredential;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type DecisionProviderCapabilities = {
  questionTypes: readonly DecisionQuestion['type'][];
  simultaneousQuestions: boolean;
  choiceProbabilities: 'required' | 'optional' | 'unavailable';
  ordinalProbabilities: 'required' | 'optional' | 'unavailable';
  binaryProbabilities: boolean;
  maxChoices: number;
  maxOrdinalLevels: number;
  maxStateBytes: number;
  maxRequestBytes: number;
  contextLimits?: { maxInputTokens: number; maxStateAndQuestionTokens?: number };
  probabilitySemantics: DecisionProbabilitySemantics;
  calibrationReference?: string;
};

export type DecisionProviderResult = {
  answers: Record<string, DecisionAnswer>;
  model: string;
  usage?: DecisionUsage;
};

export type DecisionProviderContext = {
  signal: AbortSignal;
  timeoutMs: number;
  /** Explicit injection for contract tests or a caller-controlled transport. */
  fetch?: typeof fetch;
};

export type DecisionProvider = {
  id: string;
  adapterVersion: string;
  capabilities: DecisionProviderCapabilities;
  evaluate(input: DecisionInput, context: DecisionProviderContext): Promise<DecisionProviderResult>;
};

export type DecisionProviderRegistry = { get(providerId: string): DecisionProvider | undefined };
