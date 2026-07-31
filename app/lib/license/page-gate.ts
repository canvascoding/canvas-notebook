export function shouldRequirePageLicense(input: {
  allowUnlicensed: boolean;
  onboardingEnabled: boolean;
  onboardingComplete: boolean;
}): boolean {
  if (input.allowUnlicensed) return false;
  return !input.onboardingEnabled || input.onboardingComplete;
}
