import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

/**
 * QR code rendered locally.
 *
 * The pairing payload contains the Henry ID and the pairing PIN, so sending it
 * to a public QR image service (api.qrserver.com, which this previously used)
 * handed live pairing credentials to a third party — and the image simply never
 * appeared at all when that host was unreachable or blocked, leaving the screen
 * showing an empty white box. Generating the QR in the app fixes both.
 */
export default function QrCodeImage({
  value,
  size = 200,
  className = '',
  alt = 'QR code',
}: {
  value: string;
  size?: number;
  className?: string;
  alt?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!value) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    void QRCode.toCanvas(canvas, value, {
      width: size,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0b12', light: '#ffffff' },
    })
      .then(() => {
        if (!cancelled) setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not render QR code');
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (!value) return null;

  if (error) {
    return (
      <div
        className={`flex items-center justify-center rounded-lg bg-white/90 text-black/70 text-[11px] text-center ${className}`}
        style={{ width: size, height: size }}
      >
        <p className="px-3">
          Could not render the QR code. Copy the link below and open it on your phone.
        </p>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={alt}
      width={size}
      height={size}
      className={`rounded-lg bg-white ${className}`}
      style={{ width: size, height: size }}
    />
  );
}