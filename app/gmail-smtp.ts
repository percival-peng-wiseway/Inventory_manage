import { connect } from "cloudflare:sockets";

type GmailSmtpOptions = {
  username: string;
  appPassword: string;
  to: string;
  cc?: string[];
  subject: string;
  text: string;
};

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 465;
const SMTP_TIMEOUT_MS = 12_000;

export function isEmailAddress(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !/[\r\n]/.test(value);
}

export async function sendGmailSmtp(options: GmailSmtpOptions) {
  const username = options.username.trim();
  const appPassword = options.appPassword.replace(/\s+/g, "");
  const recipient = options.to.trim();
  const ccRecipients = (options.cc || []).map((address) => address.trim());
  if (!isEmailAddress(username) || !isEmailAddress(recipient) || ccRecipients.some((address) => !isEmailAddress(address))) {
    throw new Error("Invalid SMTP email address");
  }
  if (!appPassword) throw new Error("Missing Gmail app password");

  const socket = connect(
    { hostname: SMTP_HOST, port: SMTP_PORT },
    { secureTransport: "on", allowHalfOpen: false },
  );
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let responseBuffer = "";

  const readResponse = async (expectedCodes: number[]) => {
    while (true) {
      let newlineIndex = responseBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = responseBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        responseBuffer = responseBuffer.slice(newlineIndex + 1);
        const match = line.match(/^(\d{3})([ -])/);
        if (match?.[2] === " ") {
          const code = Number(match[1]);
          if (!expectedCodes.includes(code)) {
            throw new Error(`Gmail SMTP rejected the request (${code})`);
          }
          return;
        }
        newlineIndex = responseBuffer.indexOf("\n");
      }

      const chunk = await withTimeout(reader.read(), SMTP_TIMEOUT_MS);
      if (chunk.done) throw new Error("Gmail SMTP closed the connection unexpectedly");
      responseBuffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  const command = async (value: string, expectedCodes: number[]) => {
    await withTimeout(writer.write(encoder.encode(`${value}\r\n`)), SMTP_TIMEOUT_MS);
    await readResponse(expectedCodes);
  };

  try {
    await readResponse([220]);
    await command("EHLO inventorymanage", [250]);
    await command("AUTH LOGIN", [334]);
    await command(toBase64(username), [334]);
    await command(toBase64(appPassword), [235]);
    await command(`MAIL FROM:<${username}>`, [250]);
    await command(`RCPT TO:<${recipient}>`, [250, 251]);
    for (const ccRecipient of ccRecipients) {
      if (ccRecipient !== recipient) await command(`RCPT TO:<${ccRecipient}>`, [250, 251]);
    }
    await command("DATA", [354]);

    const message = createMimeMessage(username, recipient, ccRecipients, options.subject, options.text);
    await command(`${message.replace(/^\./gm, "..")}\r\n.`, [250]);
    await command("QUIT", [221]);
  } finally {
    try {
      socket.close();
    } catch {
      // The socket may already be closed after a connection or authentication failure.
    }
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read can keep the reader locked until the socket closes.
    }
    try {
      writer.releaseLock();
    } catch {
      // The writer can already be released by a failed connection.
    }
  }
}

function createMimeMessage(from: string, to: string, cc: string[], subject: string, body: string) {
  const safeSubject = subject.replace(/[\r\n]+/g, " ").trim();
  return [
    `From: Inventory Management <${from}>`,
    `To: <${to}>`,
    ...(cc.length ? [`Cc: ${cc.map((address) => `<${address}>`).join(", ")}`] : []),
    `Subject: =?UTF-8?B?${toBase64(safeSubject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(toBase64(body)),
  ].join("\r\n");
}

function toBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function wrapBase64(value: string) {
  return value.match(/.{1,76}/g)?.join("\r\n") || "";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Gmail SMTP connection timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
