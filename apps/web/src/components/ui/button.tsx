import type { ButtonHTMLAttributes } from "react";

export function Button({
  className = "",
  type = "button",
  ...properties
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`button ${className}`} type={type} {...properties} />
  );
}
