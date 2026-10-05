/**
 * Certificates for the phone camera page.
 *
 * Phone browsers allow the camera only on secure (HTTPS) pages. This computer makes its own small
 * certificate authority once — limited by name constraints (RFC 5280 §4.2.1.10) to private network
 * addresses and local names, so even if its key leaked it couldn't vouch for any public site — and
 * signs the page's certificate with it. Two ways to use it:
 *   - Trust this computer once (install the authority on the phone): no warnings again, even when the
 *     laptop's address changes. The page's certificate meets Apple's TLS rules (SHA-256, 2048-bit RSA,
 *     server-auth usage, addresses in subjectAltName, ≤ 825 days).
 *   - Or tap through the browser's warning each time.
 */
import { createHash, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 } as const;

// ---- DER for NameConstraints (x509 has no class for it) --------------------------------------------
const len = (n: number): number[] => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, body: number[]): number[] => [tag, ...len(body.length), ...body];
const ipSubtree = (ip: string, mask: string) => tlv(0x30, tlv(0x87, [...ip.split(".").map(Number), ...mask.split(".").map(Number)]));
const dnsSubtree = (name: string) => tlv(0x30, tlv(0x82, [...Buffer.from(name, "ascii")]));
/** Permitted: private IPv4 ranges, loopback, link-local; the names localhost and *.local. */
const nameConstraints = (): ArrayBuffer => {
  const permitted = [
    ipSubtree("10.0.0.0", "255.0.0.0"),
    ipSubtree("172.16.0.0", "255.240.0.0"),
    ipSubtree("192.168.0.0", "255.255.0.0"),
    ipSubtree("127.0.0.0", "255.0.0.0"),
    ipSubtree("169.254.0.0", "255.255.0.0"),
    dnsSubtree("localhost"),
    dnsSubtree("local"),
  ].flat();
  return new Uint8Array(tlv(0x30, tlv(0xa0, permitted))).buffer;
};

const pem = (label: string, der: ArrayBuffer) => `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").replace(/.{64}/g, "$&\n").trim()}\n-----END ${label}-----\n`;
const serial = () => Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("hex").replace(/^[89a-f]/, "1");

export interface Authority {
  readonly certPem: string;
  readonly certDer: Buffer;
  readonly keyPkcs8: string; // base64
  /** SHA-256 of the certificate, to show so the person can recognise it. */
  readonly fingerprint: string;
  readonly name: string;
}

/** This computer's certificate authority, made once and kept. */
export const authority = async (dir: string): Promise<Authority> => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "local-authority.json");
  if (existsSync(file)) {
    try {
      const a = JSON.parse(readFileSync(file, "utf8")) as { certPem: string; keyPkcs8: string; name: string };
      const c = new x509.X509Certificate(a.certPem);
      if (c.notAfter.getTime() > Date.now() + 30 * 864e5) return { ...a, certDer: Buffer.from(c.rawData), fingerprint: fp(c.rawData) };
    } catch {
      // made again below
    }
  }
  const name = `Before Effects on ${hostname()}`.slice(0, 60);
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: `CN=${name.replace(/[,=+<>#;"\\]/g, " ")}, O=Before Effects (local only)`,
    notBefore: new Date(now - 864e5),
    notAfter: new Date(now + 10 * 365 * 864e5),
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      new x509.Extension("2.5.29.30", true, nameConstraints()),
    ],
  });
  const keyPkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
  const a = { certPem: cert.toString("pem"), keyPkcs8, name };
  writeFileSync(file, JSON.stringify(a));
  return { ...a, certDer: Buffer.from(cert.rawData), fingerprint: fp(cert.rawData) };
};

const fp = (der: ArrayBuffer) =>
  createHash("sha256")
    .update(Buffer.from(der))
    .digest("hex")
    .toUpperCase()
    .match(/../g)!
    .join(":");

/** The page's certificate for these addresses, signed by the authority (kept until the addresses change). */
export const serverCertificate = async (dir: string, ips: readonly string[]): Promise<{ key: string; cert: string; ca: string }> => {
  const ca = await authority(dir);
  const file = join(dir, "phone-server-certificate.json");
  const want = [...ips].sort().join(",");
  if (existsSync(file)) {
    try {
      const c = JSON.parse(readFileSync(file, "utf8")) as { ips: string; until: number; key: string; cert: string; caFingerprint: string };
      if (c.ips === want && c.until > Date.now() + 7 * 864e5 && c.caFingerprint === ca.fingerprint) return { key: c.key, cert: c.cert, ca: ca.certPem };
    } catch {
      // made again below
    }
  }
  const caCert = new x509.X509Certificate(ca.certPem);
  const caKey = await webcrypto.subtle.importKey("pkcs8", Buffer.from(ca.keyPkcs8, "base64"), ALG, false, ["sign"]);
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const now = Date.now();
  const days = 800;
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: "CN=Before Effects phone camera",
    issuer: caCert.subject,
    notBefore: new Date(now - 864e5),
    notAfter: new Date(now + days * 864e5),
    signingKey: caKey as unknown as CryptoKey,
    publicKey: keys.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([...ips.map((ip) => ({ type: "ip" as const, value: ip })), { type: "ip", value: "127.0.0.1" }, { type: "dns", value: "localhost" }]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
    ],
  });
  const key = pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  // The chain: the page's certificate, then the authority (phones that trust it build the path).
  const chain = cert.toString("pem") + "\n" + ca.certPem;
  writeFileSync(file, JSON.stringify({ ips: want, until: now + days * 864e5, key, cert: chain, caFingerprint: ca.fingerprint }));
  return { key, cert: chain, ca: ca.certPem };
};

/** An iOS configuration profile that installs the authority (Settings then asks to trust it). */
export const mobileConfig = (a: Authority): string => {
  const uuid = () => webcrypto.randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>PayloadContent</key><array><dict>
    <key>PayloadCertificateFileName</key><string>before-effects-local.cer</string>
    <key>PayloadContent</key><data>${a.certDer.toString("base64")}</data>
    <key>PayloadDescription</key><string>Lets this phone open the Before Effects camera page on ${escapeXml(a.name)} without a warning. Limited to local network addresses.</string>
    <key>PayloadDisplayName</key><string>${escapeXml(a.name)}</string>
    <key>PayloadIdentifier</key><string>app.before-effects.local-authority.cert</string>
    <key>PayloadType</key><string>com.apple.security.root</string>
    <key>PayloadUUID</key><string>${uuid()}</string>
    <key>PayloadVersion</key><integer>1</integer>
  </dict></array>
  <key>PayloadDisplayName</key><string>Before Effects (this computer)</string>
  <key>PayloadIdentifier</key><string>app.before-effects.local-authority</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid()}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict></plist>`;
};
const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
