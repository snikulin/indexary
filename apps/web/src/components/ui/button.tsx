import { forwardRef, type ButtonHTMLAttributes } from "react";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function Button({ className = "", type = "button", ...properties }, ref) {
  return (
    <button
      ref={ref}
      className={`button ${className}`}
      type={type}
      {...properties}
    />
  );
});
