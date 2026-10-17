import { X509Certificate } from "node:crypto";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { TLSSocket, createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import type { AddressInfo } from "node:net";
import { generate } from "selfsigned";

export interface SelfSignedCert {
  key: string;
  cert: string;
  fingerprint256: string;
}

/** Fresh self-signed certificate (EC P-256), the way a self-hosted mail server would have one. */
export async function selfSignedCert(commonName = "mail.selfhosted.test"): Promise<SelfSignedCert> {
  const pems = await generate([{ name: "commonName", value: commonName }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "subjectAltName", altNames: [{ type: 2, value: commonName }] },
    ],
  });
  return { key: pems.private, cert: pems.cert, fingerprint256: new X509Certificate(pems.cert).fingerprint256 };
}

/** Server certificate issued by a private (company) CA; the CA is not in any trust store. */
export async function caSignedCert(
  commonName = "mail.company.test",
  existingCa?: { key: string; cert: string },
): Promise<SelfSignedCert & { ca: { key: string; cert: string } }> {
  let ca = existingCa;
  if (!ca) {
    const pems = await generate([{ name: "commonName", value: "Company Internal CA" }], {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true },
      ],
    });
    ca = { key: pems.private, cert: pems.cert };
  }
  const leaf = await generate([{ name: "commonName", value: commonName }], {
    keyType: "ec",
    curve: "P-256",
    algorithm: "sha256",
    ca,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "subjectAltName", altNames: [{ type: 2, value: commonName }] },
    ],
  });
  return { key: leaf.private, cert: leaf.cert, fingerprint256: new X509Certificate(leaf.cert).fingerprint256, ca };
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

function listen(server: NetServer | TlsServer, sockets: Set<Socket>): Promise<RunningServer> {
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}

/** Implicit-TLS server that greets like an IMAP server. */
export function startTlsServer(cert: SelfSignedCert, greeting = "* OK test ready\r\n"): Promise<RunningServer> {
  const server = createTlsServer({ key: cert.key, cert: cert.cert }, (socket) => {
    socket.on("error", () => {});
    socket.write(greeting);
  });
  server.on("tlsClientError", () => {});
  return listen(server, new Set());
}

/** Plain server that upgrades to TLS after IMAP "STARTTLS" or SMTP "EHLO"/"STARTTLS". */
export function startStartTlsServer(cert: SelfSignedCert, protocol: "imap" | "smtp", opts: { offerStartTls?: boolean } = {}): Promise<RunningServer> {
  const offer = opts.offerStartTls ?? true;
  const server = createNetServer((socket) => {
    socket.on("error", () => {});
    socket.write(protocol === "imap" ? "* OK [CAPABILITY IMAP4rev1 STARTTLS] ready\r\n" : "220-mail.selfhosted.test ESMTP\r\n220 ready\r\n");
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      while (buffer.includes("\r\n")) {
        const line = buffer.slice(0, buffer.indexOf("\r\n"));
        buffer = buffer.slice(buffer.indexOf("\r\n") + 2);
        const upgrade = () => {
          socket.off("data", onData);
          const secure = new TLSSocket(socket, { isServer: true, key: cert.key, cert: cert.cert });
          secure.on("error", () => {});
        };
        if (protocol === "imap" && /^a\d+ STARTTLS$/i.test(line)) {
          const tag = line.split(" ")[0];
          socket.write(offer ? `${tag} OK Begin TLS negotiation now\r\n` : `${tag} BAD STARTTLS not supported\r\n`);
          if (offer) upgrade();
        } else if (protocol === "smtp" && /^EHLO /i.test(line)) {
          socket.write(offer ? "250-mail.selfhosted.test\r\n250-PIPELINING\r\n250 STARTTLS\r\n" : "250-mail.selfhosted.test\r\n250 PIPELINING\r\n");
        } else if (protocol === "smtp" && /^STARTTLS$/i.test(line)) {
          socket.write("220 2.0.0 Ready to start TLS\r\n");
          upgrade();
        }
      }
    };
    socket.on("data", onData);
  });
  return listen(server, new Set());
}
