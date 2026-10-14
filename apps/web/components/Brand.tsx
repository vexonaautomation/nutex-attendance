'use client';
import { useId } from 'react';

/** The NUTEX mark: a faceted gem carrying an N, with a location pin dot (attendance that knows where you are). Pure SVG, so it is crisp at any size. */
export function Brand({ size = 'sm', alt = 'NUTEX Attendance' }: { size?: 'sm' | 'lg'; alt?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <span className={`brand-mark ${size}`}>
      <svg viewBox="0 0 64 64" role="img" aria-label={alt}>
        <defs>
          <linearGradient id={`a${id}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8dbbff" /><stop offset="1" stopColor="#5a4bff" /></linearGradient>
          <linearGradient id={`b${id}`} x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#8b5cf6" /><stop offset="1" stopColor="#3b82f6" /></linearGradient>
          <linearGradient id={`c${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffb06a" /><stop offset="1" stopColor="#ff6a1f" /></linearGradient>
        </defs>
        <g className="gem">
          <path d="M32 3 56 17v30L32 61 8 47V17Z" fill={`url(#a${id})`} />
          <path d="M32 3 8 17v30l24-14Z" fill="#fff" opacity=".2" />
          <path d="M32 33 56 17v30L32 61Z" fill={`url(#b${id})`} opacity=".85" />
          <path d="M32 3 56 17 32 31 8 17Z" fill="#fff" opacity=".28" />
          <path d="M21 43V22l22 21V22" fill="none" stroke="#fff" strokeWidth="5.4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="49" cy="14" r="6.2" fill={`url(#c${id})`} stroke="#fff" strokeWidth="2" />
        </g>
      </svg>
    </span>
  );
}
