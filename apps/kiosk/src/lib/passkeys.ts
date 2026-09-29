/**
 * The device's fingerprint sensor, through WebAuthn.
 *
 * The server builds every option and checks every answer
 * (`apps/api/src/modules/attendance/passkeys.service.ts`); this file only
 * carries them between the server and the browser, unchanged. The one real job
 * it has is the encoding: the server speaks the WebAuthn **JSON** forms
 * (base64url strings), the browser API speaks `ArrayBuffer`s, and this file
 * translates faithfully in both directions. Newer browsers can do this
 * themselves (`parseRequestOptionsFromJSON`, `toJSON`), but a kiosk is whatever
 * phone the company screwed to the wall, so it is done by hand here and tested.
 *
 * What a fingerprint means — and does not mean — is written where it matters:
 * the sensor proves *a finger saved on this device* unlocked the key, never
 * *whose* finger (docs/plan/13-biometrics-design.md section 4). That is why the
 * server only ever asks for it alongside a face or a staff number.
 */

/** `PublicKeyCredentialRequestOptionsJSON`: what the server sends to use a key. */
export interface RequestOptionsJson {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
}

/** `AuthenticationResponseJSON`: what goes back, unchanged, as `assertion`. */
export interface AssertionJson {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string | null;
  };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment: string | null;
}

/** `PublicKeyCredentialCreationOptionsJSON`: what the server sends to save a key. */
export interface CreationOptionsJson {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout?: number;
  excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

/** `RegistrationResponseJSON`: what goes back, unchanged, as `response`. */
export interface RegistrationJson {
  id: string;
  rawId: string;
  type: 'public-key';
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports: string[];
  };
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment: string | null;
}

/** A sensor refusal the screen can show, in words a guard can act on. */
export class FingerprintRefused extends Error {
  /** True when the person cancelled or the sensor timed out — worth retrying. */
  readonly cancelled: boolean;

  constructor(message: string, cancelled: boolean) {
    super(message);
    this.name = 'FingerprintRefused';
    this.cancelled = cancelled;
  }
}

/** Whether this browser has the sensor API at all. */
export function passkeysAvailable(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && 'credentials' in navigator;
}

/**
 * The contract deliberately keeps the WebAuthn options opaque (`Pass them
 * unchanged to the browser`), so its generated type carries no fields. This is
 * the one sanctioned crossing from that opaque type to the JSON shape this
 * file translates — screens use it instead of scattering casts.
 */
export function requestOptionsFrom(options: object): RequestOptionsJson {
  return options as unknown as RequestOptionsJson;
}

/** The same crossing for creating a key (`PasskeyCreationOptions`). */
export function creationOptionsFrom(options: object): CreationOptionsJson {
  return options as unknown as CreationOptionsJson;
}

/**
 * Asks the device's sensor to prove a saved finger, and returns the answer in
 * the JSON form the server checks. The options are the server's, unchanged.
 */
export async function getAssertion(options: RequestOptionsJson): Promise<AssertionJson> {
  const credential = await askTheSensor(() =>
    navigator.credentials.get({
      publicKey: {
        challenge: fromBase64Url(options.challenge),
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification,
        allowCredentials: options.allowCredentials?.map((allowed) => ({
          id: fromBase64Url(allowed.id),
          type: 'public-key' as const,
          transports: allowed.transports as AuthenticatorTransport[] | undefined,
        })),
      },
    }),
  );
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      userHandle: response.userHandle === null ? null : toBase64Url(response.userHandle),
    },
    clientExtensionResults: { ...credential.getClientExtensionResults() },
    authenticatorAttachment: credential.authenticatorAttachment,
  };
}

/**
 * Asks the device to make a new key that only an enrolled finger unlocks, and
 * returns the answer in the JSON form the server checks.
 */
export async function createPasskey(options: CreationOptionsJson): Promise<RegistrationJson> {
  const credential = await askTheSensor(() =>
    navigator.credentials.create({
      publicKey: {
        challenge: fromBase64Url(options.challenge),
        rp: options.rp,
        user: {
          id: fromBase64Url(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        excludeCredentials: options.excludeCredentials?.map((excluded) => ({
          id: fromBase64Url(excluded.id),
          type: 'public-key' as const,
          transports: excluded.transports as AuthenticatorTransport[] | undefined,
        })),
        authenticatorSelection: options.authenticatorSelection,
        attestation: options.attestation,
      },
    }),
  );
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: response.getTransports === undefined ? [] : response.getTransports(),
    },
    clientExtensionResults: { ...credential.getClientExtensionResults() },
    authenticatorAttachment: credential.authenticatorAttachment,
  };
}

/** Runs one sensor call and turns every way it can fail into plain words. */
async function askTheSensor(call: () => Promise<Credential | null>): Promise<PublicKeyCredential> {
  if (!passkeysAvailable()) {
    throw new FingerprintRefused('This phone has no fingerprint sensor the kiosk can use.', false);
  }
  let credential: Credential | null;
  try {
    credential = await call();
  } catch (error) {
    // `NotAllowedError` is the sensor's one word for cancelled, timed out and
    // "the sheet was dismissed" alike — the only answer is to try again.
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new FingerprintRefused('The fingerprint was not read. Try again.', true);
    }
    if (error instanceof DOMException && error.name === 'InvalidStateError') {
      throw new FingerprintRefused('This key is already saved on this phone.', false);
    }
    throw new FingerprintRefused('The fingerprint sensor would not start.', false);
  }
  if (!(credential instanceof PublicKeyCredential)) {
    throw new FingerprintRefused('The fingerprint was not read. Try again.', true);
  }
  return credential;
}

/**
 * WebAuthn's base64url: `-` and `_`, no padding. `atob`/`btoa` speak plain
 * base64, so the translation is spelled out — and tested, because one wrong
 * character here fails every fingerprint with an error that names nothing.
 */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const plain = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = plain + '='.repeat((4 - (plain.length % 4)) % 4);
  const bytes = atob(padded);
  const buffer = new Uint8Array(new ArrayBuffer(bytes.length));
  for (let i = 0; i < bytes.length; i += 1) {
    buffer[i] = bytes.charCodeAt(i);
  }
  return buffer;
}

export function toBase64Url(buffer: ArrayBuffer): string {
  let text = '';
  for (const byte of new Uint8Array(buffer)) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
