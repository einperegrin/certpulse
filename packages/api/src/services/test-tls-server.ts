import { createServer, type Server, type TlsOptions } from "node:tls";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TlsTestServer {
  port: number;
  close(): Promise<void>;
}

function formatAsn1Date(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function makeCert(daysValid: number): { cert: string; key: string } {
  const dir = mkdtempSync(join(tmpdir(), "cert-"));
  const caKeyPath = join(dir, "ca.key");
  const caCertPath = join(dir, "ca.pem");
  const leafKeyPath = join(dir, "leaf.key");
  const csrPath = join(dir, "leaf.csr");
  const leafCertPath = join(dir, "leaf.pem");
  const indexPath = join(dir, "index.txt");
  const serialPath = join(dir, "serial");
  const confPath = join(dir, "openssl.cnf");

  writeFileSync(confPath, [
    "[ ca ]",
    "default_ca = CA_default",
    "[ CA_default ]",
    `dir = ${dir}`,
    `database = ${indexPath}`,
    `serial = ${serialPath}`,
    `new_certs_dir = ${dir}`,
    `certificate = ${caCertPath}`,
    `private_key = ${caKeyPath}`,
    "default_md = sha256",
    "policy = policy_any",
    "[ policy_any ]",
    "commonName = supplied",
    "",
  ].join("\n"));
  writeFileSync(indexPath, "");
  writeFileSync(serialPath, "01\n");

  execSync(`openssl genrsa -out ${caKeyPath} 2048`, { stdio: "ignore" });
  execSync(
    `openssl req -x509 -new -key ${caKeyPath} -out ${caCertPath} -days 3650 -subj "/CN=TestCA" -nodes`,
    { stdio: "ignore" }
  );

  if (daysValid >= 0) {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${leafKeyPath} -out ${leafCertPath} -days ${daysValid === 0 ? 1 : daysValid} -nodes -subj "/CN=localhost"`,
      { stdio: "ignore" }
    );
  } else {
    execSync(`openssl genrsa -out ${leafKeyPath} 2048`, { stdio: "ignore" });
    execSync(
      `openssl req -new -key ${leafKeyPath} -subj "/CN=localhost" -out ${csrPath}`,
      { stdio: "ignore" }
    );
    const endDate = formatAsn1Date(
      new Date(Date.now() - 86400_000 * Math.min(2, Math.abs(daysValid)))
    );
    execSync(
      `openssl ca -config ${confPath} -in ${csrPath} -out ${leafCertPath} -enddate ${endDate} -batch`,
      { stdio: "ignore" }
    );
  }

  const cert = readFileSync(leafCertPath, "utf-8");
  const key = readFileSync(leafKeyPath, "utf-8");
  rmSync(dir, { recursive: true, force: true });
  return { cert, key };
}

export async function startTlsTestServer(opts: {
  daysValid: number;
  port?: number;
}): Promise<TlsTestServer> {
  const { cert, key } = makeCert(opts.daysValid);
  const tlsOpts: TlsOptions = { cert, key };
  const server: Server = createServer(tlsOpts, (socket) => {
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
    socket.end();
  });
  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, "127.0.0.1", resolve)
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind TLS test server");
  }
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}
