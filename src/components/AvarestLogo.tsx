import React from 'react';

interface AvarestLogoProps {
  variant?: 'horizontal' | 'compact' | 'mark';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function AvarestLogo({
  variant = 'horizontal',
  size = 'md',
  className = '',
}: AvarestLogoProps) {
  const iconDims =
    size === 'sm' ? 'w-7 h-7' : size === 'lg' ? 'w-12 h-12' : 'w-8 h-8';

  const prismMark = (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={`${iconDims} shrink-0`}
    >
      <defs>
        <linearGradient id="avarest-mark-grad" x1="8" y1="6" x2="58" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#312E81" />
          <stop offset="55%" stopColor="#4F46E5" />
          <stop offset="100%" stopColor="#06B6D4" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#avarest-mark-grad)" />
      <path d="M32 13L15.5 49H23.2L32 28.6L40.8 49H48.5L32 13Z" fill="#FFFFFF" />
      <path d="M23.5 39.5L32 35.2L40.5 39.5L32 43.2L23.5 39.5Z" fill="#22D3EE" />
    </svg>
  );

  if (variant === 'compact' || variant === 'mark') {
    return (
      <span className={`inline-flex items-center justify-center shrink-0 ${className}`}>
        {prismMark}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-2.5 min-w-0 ${className}`}>
      {prismMark}
      <span className="flex flex-col leading-none min-w-0">
        <span className="font-display font-bold text-base tracking-tight text-slate-900 dark:text-white truncate">
          Avarest One
        </span>
        <span className="text-[10px] font-medium tracking-wide text-slate-500 dark:text-slate-400 truncate">
          by Avarest AI
        </span>
      </span>
    </span>
  );
}
