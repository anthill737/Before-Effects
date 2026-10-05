/** The phone page's certificates, checked with Node's own TLS (OpenSSL), not the library that made them. */
import { X509Certificate } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:tls";
import { describe, expect, it } from "vitest";
import { authority, mobileConfig, serverCertificate } from "../src/main/phoneCert.ts";

const handshake = (cert: { key: string; cert: string }, ca: string | null): Promise<{ ok: boolean; error?: string }> =>
  new Promise((resolve) => {
    const server = createServer({ key: cert.key, cert: cert.cert }, (s) => s.end());
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const c = connect({ host: "127.0.0.1", port, ...(ca ? { ca } : {}), rejectUnauthorized: true }, () => {
        c.end();
        server.close();
        resolve({ ok: true });
      });
      c.on("error", (e) => {
        server.close();
        resolve({ ok: false, error: (e as NodeJS.ErrnoException).code ?? e.message });
      });
    });
  });

describe("phone page certificates", () => {
  const dir = mkdtempSync(join(tmpdir(), "be-cert-"));

  it("a phone that trusts this computer's authority accepts the page; one that doesn't is warned", async () => {
    const c = await serverCertificate(dir, ["192.168.1.50"]);
    expect((await handshake(c, c.ca)).ok).toBe(true);
    const untrusted = await handshake(c, null);
    expect(untrusted.ok).toBe(false);
    console.log("without the authority:", untrusted.error);
  });

  it("the page's certificate meets Apple's TLS requirements", async () => {
    const c = await serverCertificate(dir, ["192.168.1.50", "10.0.0.7"]);
    const leaf = new X509Certificate(c.cert.split(/(?=-----BEGIN CERTIFICATE-----)/)[0]!);
    const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / 864e5;
    expect(days).toBeLessThanOrEqual(825);
    expect(leaf.subjectAltName).toContain("IP Address:192.168.1.50");
    expect(leaf.subjectAltName).toContain("IP Address:10.0.0.7");
    expect(leaf.keyUsage ?? []).toContain("1.3.6.1.5.5.7.3.1"); // serverAuth
    expect(leaf.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(leaf.toLegacyObject().asn1Curve ?? "rsa").toBe("rsa");
    const ca = new X509Certificate((await authority(dir)).certPem);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(ca.ca).toBe(true);
  });

  it("the authority can't vouch for a public address (name constraints are enforced)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "be-cert-"));
    // Same authority, a certificate claiming a public address.
    const a = await authority(dir);
    const { writeFileSync, copyFileSync } = await import("node:fs");
    copyFileSync(join(dir, "local-authority.json"), join(outside, "local-authority.json"));
    void writeFileSync;
    const bad = await serverCertificate(outside, ["8.8.8.8"]);
    expect(bad.ca).toBe(a.certPem);
    const r = await handshake(bad, bad.ca);
    console.log("certificate for 8.8.8.8:", r);
    expect(r.ok).toBe(false);
  });

  it("makes an iOS profile holding the authority", async () => {
    const a = await authority(dir);
    const x = mobileConfig(a);
    expect(x).toContain("com.apple.security.root");
    expect(x).toContain(a.certDer.toString("base64"));
  });
});
