import crypto from 'node:crypto';

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;
const commitShaPattern = /^[a-f0-9]{40,64}$/u;
const releaseVersionPattern = /^v?\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/u;

export function buildControlPlaneReleasePayload(env, packageVersion, publishedAt = new Date().toISOString()) {
  const mergeTag = env.MERGE_TAG || 'latest';
  const isTag = releaseVersionPattern.test(mergeTag);
  const tag = isTag ? mergeTag.replace(/^v/iu, '') : '';
  const version = tag || String(packageVersion || '');
  if (isTag && tag !== String(packageVersion || '')) {
    throw new Error(`Release tag ${mergeTag} does not match package version ${packageVersion}.`);
  }
  const imageName = String(env.GHCR_IMAGE || '').trim();
  const imageDigest = String(env.IMAGE_DIGEST || '').trim();
  if (!imageName || !digestPattern.test(imageDigest)) {
    throw new Error('Immutable GHCR image name and sha256 digest are required for the release webhook.');
  }
  const tags = [`${imageName}:latest`];
  if (isTag) tags.push(`${imageName}:${mergeTag}`);
  const releaseRef = String(env.RELEASE_REF || env.GITHUB_REF || '').trim();
  const releaseTag = String(env.RELEASE_TAG || (isTag ? mergeTag : `v${version}`)).trim();
  const releaseCommitSha = String(env.RELEASE_COMMIT_SHA || env.GITHUB_SHA || '').trim();
  const expectedReleaseRef = `refs/tags/v${version}`;
  if (releaseRef !== expectedReleaseRef || releaseTag !== `v${version}` || !commitShaPattern.test(releaseCommitSha)) {
    throw new Error(`Release payload provenance must resolve to ${expectedReleaseRef} and an immutable commit SHA.`);
  }

  let cliArtifact;
  let linuxCli;
  if (isTag) {
    const cliSha256 = String(env.HOST_CLI_SHA256 || '').trim();
    const linuxAmd64Sha256 = String(env.LINUX_CLI_AMD64_SHA256 || '').trim();
    const linuxArm64Sha256 = String(env.LINUX_CLI_ARM64_SHA256 || '').trim();
    const cliVersion = String(env.HOST_CLI_VERSION || mergeTag).trim();
    if (!releaseVersionPattern.test(cliVersion) || !shaPattern.test(cliSha256)) {
      throw new Error('Tagged releases require a validated host CLI version and sha256.');
    }
    if (!shaPattern.test(linuxAmd64Sha256) || !shaPattern.test(linuxArm64Sha256)) {
      throw new Error('Tagged releases require validated amd64 and arm64 Linux CLI sha256 values.');
    }
    cliArtifact = { version: cliVersion, sha256: cliSha256 };
    linuxCli = {
      amd64: { filename: 'canvas-notebook-linux-cli-amd64.tar.gz', sha256: linuxAmd64Sha256 },
      arm64: { filename: 'canvas-notebook-linux-cli-arm64.tar.gz', sha256: linuxArm64Sha256 },
    };
  }

  return {
    event: isTag ? 'release_published' : 'image_rebuilt',
    repository: env.GITHUB_REPOSITORY,
    ref: releaseRef,
    tag: releaseTag,
    version,
    commitSha: releaseCommitSha,
    image: { name: imageName, tags, digest: imageDigest },
    cliArtifact,
    linuxCli,
    workflow: {
      runId: env.RELEASE_BUILD_RUN_ID || env.GITHUB_RUN_ID,
      runNumber: env.RELEASE_BUILD_RUN_NUMBER || env.GITHUB_RUN_NUMBER,
      runAttempt: env.RELEASE_BUILD_RUN_ATTEMPT || env.GITHUB_RUN_ATTEMPT,
    },
    source: 'github_actions',
    publishedAt,
    metadata: {
      actor: env.GITHUB_ACTOR,
      eventName: env.GITHUB_EVENT_NAME,
      workflow: env.GITHUB_WORKFLOW,
      notificationWorkflow: {
        runId: env.GITHUB_RUN_ID,
        runNumber: env.GITHUB_RUN_NUMBER,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
      },
    },
  };
}

export function signControlPlaneReleasePayload(secret, timestamp, body) {
  if (!secret) throw new Error('Release webhook secret is required.');
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}
