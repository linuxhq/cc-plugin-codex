export const sensitive =
  /(^|\/)(\.env(?:\..*)?|\.git|id_rsa|id_ed25519)(\/|$)|\.(pem|key)$/i;

// Explicit glob magic makes **/ match zero directories as well as nested paths.
export const secretExclusions = [
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
