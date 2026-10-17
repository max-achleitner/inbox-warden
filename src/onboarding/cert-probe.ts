import { X509Certificate } from "node:crypto";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface ProbeOptions {
  host: string;
  port: number;
  protocol: "imap" | "smtp";
  security: "implicit" | "starttls";
  timeoutMs?: number;
}

export interface CertificateInfo {
  pem: string;
  fingerprint256: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
  /** Whether the system trust store accepts the certificate for this host. */
  trusted: boolean;
  trustError?: string;
  hostnameMatches: boolean;
}

export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

/** Read CRLF lines until `done(lines)` is true. */
function readLines(socket: Socket, done: (lines: string[]) => boolean): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const lines: string[] = [];
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      let idx: number;
      while ((idx = buffer.indexOf("\r\n")) >= 0) {
        lines.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (done(lines)) {
          cleanup();
          resolve(lines);
          return;
        }
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new ProbeError("The server closed the connection."));
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

const smtpFinal = (lines: string[]) => /^\d{3} /.test(lines[lines.length - 1] ?? "");

async function startTlsDialog(socket: Socket, protocol: "imap" | "smtp"): Promise<void> {
  if (protocol === "imap") {
    const greeting = await readLines(socket, (l) => l.length >= 1);
    if (!/^\* (OK|PREAUTH)/i.test(greeting[0])) throw new ProbeError(`Unexpected IMAP greeting: ${greeting[0].slice(0, 80)}`);
    socket.write("a1 STARTTLS\r\n");
    const answer = await readLines(socket, (l) => l.some((x) => x.startsWith("a1 ")));
    if (!/^a1 OK/i.test(answer[answer.length - 1])) throw new ProbeError("The IMAP server does not offer STARTTLS on this port.");
    return;
  }
  const greeting = await readLines(socket, smtpFinal);
  if (!greeting[greeting.length - 1].startsWith("220")) throw new ProbeError(`Unexpected SMTP greeting: ${greeting[0].slice(0, 80)}`);
  socket.write("EHLO imap-mcp-probe\r\n");
  const ehlo = await readLines(socket, smtpFinal);
  if (!ehlo.some((l) => /^250[ -]STARTTLS\b/i.test(l))) throw new ProbeError("The SMTP server does not offer STARTTLS on this port.");
  socket.write("STARTTLS\r\n");
  const ready = await readLines(socket, smtpFinal);
  if (!ready[ready.length - 1].startsWith("220")) throw new ProbeError("The SMTP server refused STARTTLS.");
}

function describe(socket: TLSSocket, host: string): CertificateInfo {
  const peer = socket.getPeerCertificate(true);
  if (!peer || !peer.raw) throw new ProbeError("The server did not present a certificate.");
  const x509 = new X509Certificate(peer.raw);
  return {
    pem: x509.toString(),
    fingerprint256: x509.fingerprint256,
    subject: x509.subject.replace(/\n/g, ", "),
    issuer: x509.issuer.replace(/\n/g, ", "),
    validFrom: new Date(x509.validFrom).toISOString(),
    validTo: new Date(x509.validTo).toISOString(),
    selfSigned: x509.checkIssued(x509),
    trusted: socket.authorized,
    trustError: socket.authorized ? undefined : String(socket.authorizationError),
    hostnameMatches: (isIP(host) ? x509.checkIP(host) : x509.checkHost(host)) !== undefined,
  };
}

/**
 * Fetch the server certificate so the user can decide whether to trust it. Verification is
 * deliberately not enforced here: this connection only reads the certificate (like
 * `openssl s_client`), sends no credentials and is closed immediately. Whether the system
 * trusts the certificate is reported in `trusted`/`trustError`.
 */
export async function probeCertificate(opts: ProbeOptions): Promise<CertificateInfo> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const servername = isIP(opts.host) ? undefined : opts.host;
  let plain: Socket | undefined;
  let secure: TLSSocket | undefined;

  const work = (async () => {
    if (opts.security === "starttls") {
      plain = netConnect({ host: opts.host, port: opts.port });
      await new Promise<void>((resolve, reject) => {
        plain!.once("connect", () => resolve());
        plain!.once("error", reject);
      });
      await startTlsDialog(plain, opts.protocol);
    }
    secure = tlsConnect({
      ...(plain ? { socket: plain } : { host: opts.host, port: opts.port }),
      servername,
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
    });
    await new Promise<void>((resolve, reject) => {
      secure!.once("secureConnect", () => resolve());
      secure!.once("error", reject);
    });
    return describe(secure, opts.host);
  })();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeError(`No answer from ${opts.host}:${opts.port} within ${timeoutMs / 1000} s.`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    secure?.destroy();
    plain?.destroy();
  }
}
