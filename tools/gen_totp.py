#!/usr/bin/env python3
"""Generate a Google Authenticator TOTP secret, a session secret and a QR code.

Usage:
    python3 tools/gen_totp.py [--account "ram gupta"] [--issuer "NIFTY Optimizer"]

Writes totp-qr.png (scan with Google Authenticator) and prints the Base32
secret plus the wrangler commands that store both secrets in Cloudflare.
Nothing is written into the Worker source - secrets live only in Cloudflare.
"""
import argparse, base64, os, secrets, textwrap
from urllib.parse import quote

B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

def b32encode(raw: bytes) -> str:
    bits, value, out = 0, 0, []
    for byte in raw:
        value = (value << 8) | byte
        bits += 8
        while bits >= 5:
            out.append(B32[(value >> (bits - 5)) & 31])
            bits -= 5
    if bits:
        out.append(B32[(value << (5 - bits)) & 31])
    return "".join(out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account", default="ram gupta")
    ap.add_argument("--issuer", default="NIFTY Optimizer")
    ap.add_argument("--out", default="totp-qr.png")
    args = ap.parse_args()

    totp_secret = b32encode(secrets.token_bytes(20))       # 160-bit, Google Authenticator standard
    session_secret = secrets.token_hex(32)                  # 256-bit HMAC key for the session cookie

    uri = ("otpauth://totp/" + quote(args.issuer) + ":" + quote(args.account) +
           "?secret=" + totp_secret + "&issuer=" + quote(args.issuer) +
           "&algorithm=SHA1&digits=6&period=30")

    try:
        import segno
        segno.make(uri, error="m").save(args.out, scale=8, border=2)
        qr_note = f"QR code written to {args.out} - scan it with Google Authenticator."
    except ImportError:
        qr_note = "segno not installed (pip install segno) - use the manual key below."

    print("=" * 68)
    print("TOTP_SECRET (Base32, type this into the authenticator if you can't scan)")
    print("  " + totp_secret)
    print()
    print("SESSION_SECRET (HMAC key for the 12-hour session cookie)")
    print("  " + session_secret)
    print()
    print("otpauth URI")
    print(textwrap.fill(uri, 66))
    print()
    print(qr_note)
    print("=" * 68)
    print()
    print("Store them in Cloudflare (run from your project folder):")
    print("  npx wrangler secret put TOTP_SECRET")
    print("  npx wrangler secret put SESSION_SECRET")
    print("  npx wrangler deploy")

if __name__ == "__main__":
    main()
