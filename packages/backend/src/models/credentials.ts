import { z } from "zod";
import { PROVIDER_COPY } from "../shared/config";

const IV_BYTES = 12;
const TAG_BITS = 128;
const PURPOSE = "amita-provider-api-key";
export const encryptedCredentialSchema = z.object({ iv: z.string(), ciphertext: z.string() });
export type EncryptedCredential = z.infer<typeof encryptedCredentialSchema>;
const encode = (value: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(value)));
const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const binding = (provider: string) => new TextEncoder().encode(JSON.stringify([PURPOSE, provider]));

async function encryptionKey(value: string | undefined) {
  try {
    if (!value) throw new Error();
    const bytes = decode(value);
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    throw new Error(PROVIDER_COPY.encryption);
  }
}

export async function encryptCredential(
  secret: string | undefined,
  provider: string,
  value: string,
): Promise<EncryptedCredential> {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: binding(provider), tagLength: TAG_BITS },
    key,
    new TextEncoder().encode(value),
  );
  return { iv: encode(iv), ciphertext: encode(ciphertext) };
}

export async function decryptCredential(
  secret: string | undefined,
  provider: string,
  value: EncryptedCredential,
): Promise<string> {
  const key = await encryptionKey(secret);
  try {
    const { iv, ciphertext } = encryptedCredentialSchema.parse(value);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(iv), additionalData: binding(provider), tagLength: TAG_BITS },
      key,
      decode(ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error(PROVIDER_COPY.decrypt);
  }
}
