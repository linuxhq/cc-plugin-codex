export const sensitive = new RegExp(
  '(^|/)(\\.env(?:\\..*)?|\\.git|id_rsa|id_ed25519|' +
    'credentials|\\.netrc|\\.npmrc|\\.aws|\\.ssh|\\.kube|hosts\\.yml)' +
    '(/|$)|\\.(pem|key)$',
  'i',
);

// Explicit glob magic makes **/ match zero directories as well as nested paths.
export const secretExclusions = [
  ...[
    'credentials',
    '.netrc',
    '.npmrc',
    '.aws',
    '.ssh',
    '.kube',
    'hosts.yml',
  ].flatMap((name) => [`**/${name}`, `**/${name}/**`]),
  '**/.env',
  '**/.env.*',
  '**/.env/**',
  '**/.env.*/**',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa',
  '**/id_rsa/**',
  '**/id_ed25519',
  '**/id_ed25519/**',
].map((pattern) => `:(exclude,glob,icase)${pattern}`);
