import {
  detectCardBrand,
  formatCardNumber as formatCardNumberUtil,
} from "@bittery/shared/credit-card";

export const maskValue = (value: string, visibleChars = 4): string => {
  if (value.length <= visibleChars) return "•".repeat(value.length);
  return "•".repeat(value.length - visibleChars) + value.slice(-visibleChars);
};

export const formatCardNumber = (number: string): string => {
  const brand = detectCardBrand(number);
  return formatCardNumberUtil(number, brand);
};
