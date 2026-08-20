import type { ImgHTMLAttributes } from 'react';

export function HandyPosLogo({
  alt = 'Handy POS Logo',
  src = '/app-icon.png',
  className,
  ...props
}: ImgHTMLAttributes<HTMLImageElement>) {
  const resolvedClassName = className
    ? `object-contain ${className}`
    : 'object-contain';

  return (
    <img
      alt={alt}
      src={src}
      className={resolvedClassName}
      draggable={false}
      {...props}
    />
  );
}
