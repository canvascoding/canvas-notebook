import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const readSource = (relativePath: string) => readFileSync(path.join(root, relativePath), 'utf8');

const publicLogoSource = readSource('app/components/branding/PublicBrandLogo.tsx');
const sharedLogoSource = readSource('app/components/branding/BrandLogoImage.tsx');
const routeSource = readSource('app/api/public/brand/logo/route.ts');
const loginSource = readSource('app/[locale]/(routes)/login/login-client.tsx');
const setupSource = readSource('app/[locale]/(routes)/setup/setup-client.tsx');
const signUpSource = readSource('app/[locale]/(routes)/sign-up/sign-up-form.tsx');
const onboardingSource = readSource('app/[locale]/(routes)/onboarding/onboarding-wizard.tsx');
const onboardingPageSource = readSource('app/[locale]/(routes)/onboarding/page.tsx');
const publicSharePromotionSource = readSource('app/components/public-sharing/PublicSharePromotion.tsx');

assert.match(publicLogoSource, /logoUrl="\/api\/public\/brand\/logo"/u);
assert.match(sharedLogoSource, /fallbackSrc = '\/images\/bradley\/bradley-icon\.svg'/u);
assert.match(sharedLogoSource, /setFailedLogoUrl\(logoUrl\)/u);
assert.match(routeSource, /readPrimaryOrganizationBrandProfile/u);
assert.match(routeSource, /state\.profile\.appearance\.enabled/u);
assert.match(routeSource, /state\.profile\.logoPath !== ORGANIZATION_BRAND_LOGO_PATH/u);
assert.doesNotMatch(routeSource, /auth|requireRequest|requireOrganizationBrandAdmin/u);
assert.match(routeSource, /Cache-Control': 'public, no-cache'/u);

for (const source of [loginSource, setupSource, signUpSource, onboardingSource]) {
  assert.match(source, /<PublicBrandLogo/u);
  assert.doesNotMatch(source, /src="\/(?:logo\.jpg|logo-login\.webp)"/u);
}

assert.match(onboardingPageSource, /phase === 'waiting'[\s\S]*?<PublicBrandLogo/u);
assert.match(publicSharePromotionSource, /src="\/images\/bradley\/bradley-icon\.svg"/u);
assert.match(loginSource, /flex-col items-center justify-center gap-3 sm:flex-row/u);
assert.match(setupSource, /flex-col items-center justify-center gap-3 sm:flex-row/u);
assert.match(signUpSource, /flex-col items-center justify-center gap-3 sm:flex-row/u);
assert.match(onboardingSource, /flex-col items-center justify-center gap-3 sm:flex-row/u);

console.log('public-brand-logo-ui-test: ok');
