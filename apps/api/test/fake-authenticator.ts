import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * A kiosk's fingerprint sensor, for the tests.
 *
 * WebAuthn's answers are real cryptography, so a test cannot simply make one
 * up: this builds the same bytes a real device would — the authenticator
 * data, the client data and an ES256 signature over both — with a key pair it
 * keeps to itself. That way the tests exercise the actual verification, not a
 * stubbed version of it.
 *
 * Only the parts SAMTEC uses are built: one platform key per device, ES256,
 * no attestation.
 */

/** The flag bits of WebAuthn's authenticator data. */
const USER_PRESENT = 0x01;
const USER_VERIFIED = 0x04;
const BACKUP_ELIGIBLE = 0x08;
const BACKED_UP = 0x10;
const ATTESTED_DATA = 0x40;

export class FakeAuthenticator {
  /** The credential ID, as the browser reports it (base64url). */
  readonly credentialId: string;

  private readonly rawId: Uint8Array<ArrayBuffer>;
  private readonly privateKeyPem: string;
  private readonly cosePublicKey: Uint8Array<ArrayBuffer>;
  private counter = 0;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
    /** The device says it may copy this key to its cloud account. */
    private readonly synced = false,
  ) {
    this.rawId = bytes(randomBytes(16));
    this.credentialId = isoBase64URL.fromBuffer(this.rawId);
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.cosePublicKey = coseKey(
      isoBase64URL.toBuffer(jwk.x as string),
      isoBase64URL.toBuffer(jwk.y as string),
    );
  }

  /** The answer to `navigator.credentials.create(...)`, as JSON. */
  register(
    challenge: string,
    options: { userVerified?: boolean; attachment?: 'platform' | 'cross-platform' } = {},
  ): unknown {
    const authData = this.authenticatorData(ATTESTED_DATA, options.userVerified ?? true);
    const attestation = cbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      authenticatorAttachment: options.attachment ?? 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: this.clientData('webauthn.create', challenge),
        attestationObject: isoBase64URL.fromBuffer(attestation),
        transports: ['internal'],
      },
    };
  }

  /** The answer to `navigator.credentials.get(...)`, as JSON. */
  authenticate(
    challenge: string,
    options: { userVerified?: boolean; counter?: number; origin?: string } = {},
  ): unknown {
    this.counter = options.counter ?? this.counter + 1;
    const authData = this.authenticatorData(0, options.userVerified ?? true);
    const clientDataJSON = this.clientData('webauthn.get', challenge, options.origin);
    const signed = Buffer.concat([
      Buffer.from(authData),
      createHash('sha256').update(isoBase64URL.toBuffer(clientDataJSON)).digest(),
    ]);
    const signature = createSign('SHA256').update(signed).sign(this.privateKeyPem);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON,
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(bytes(signature)),
        userHandle: null,
      },
    };
  }

  private authenticatorData(extra: number, userVerified: boolean): Uint8Array<ArrayBuffer> {
    let flags = USER_PRESENT | extra;
    if (userVerified) {
      flags |= USER_VERIFIED;
    }
    if (this.synced) {
      flags |= BACKUP_ELIGIBLE | BACKED_UP;
    }
    const head = Buffer.alloc(37);
    createHash('sha256').update(this.rpId).digest().copy(head, 0);
    head.writeUInt8(flags, 32);
    head.writeUInt32BE(this.counter, 33);
    if ((extra & ATTESTED_DATA) === 0) {
      return bytes(head);
    }
    const credentialLength = Buffer.alloc(2);
    credentialLength.writeUInt16BE(this.rawId.length, 0);
    return bytes(
      Buffer.concat([
        head,
        // The AAGUID: all zeroes, which is what a platform key with no
        // attestation reports.
        Buffer.alloc(16),
        credentialLength,
        Buffer.from(this.rawId),
        Buffer.from(this.cosePublicKey),
      ]),
    );
  }

  private clientData(type: string, challenge: string, origin = this.origin): string {
    return isoBase64URL.fromBuffer(
      bytes(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8')),
    );
  }
}

/** The public half, in the COSE map WebAuthn carries it in: EC2, P-256, ES256. */
function coseKey(x: Uint8Array, y: Uint8Array): Uint8Array<ArrayBuffer> {
  return cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

/** A plain copy, so the bytes are never a view on a shared buffer. */
function bytes(from: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(from);
}

/**
 * CBOR, the format WebAuthn packs its binary answers in. The helper's own
 * type is not exported, so the map is handed over as it is.
 */
function cbor(value: Map<string | number, unknown>): Uint8Array<ArrayBuffer> {
  return bytes(isoCBOR.encode(value as Parameters<typeof isoCBOR.encode>[0]));
}
