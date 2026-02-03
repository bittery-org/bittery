import {
  detectCardBrand,
  getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import { Button, Card, Chip } from "heroui-native";
import { Copy, CreditCard, Eye, EyeOff } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import { FieldRow } from "./field-row";
import type { ItemDetailProps } from "./types";
import { formatCardNumber, maskValue } from "./utils";

const StyledCopy = withUniwind(Copy);
const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);
const StyledCreditCard = withUniwind(CreditCard);

export function CreditCardFields({ item, onCopy }: ItemDetailProps) {
  const [showCardNumber, setShowCardNumber] = useState(false);
  const [showCvv, setShowCvv] = useState(false);

  const cardBrand = item.cardNumber ? detectCardBrand(item.cardNumber) : null;
  const brandDisplayName =
    cardBrand && cardBrand !== "unknown"
      ? getCardBrandDisplayName(cardBrand)
      : null;

  return (
    <>
      <FieldRow label="Cardholder Name" value={item.cardholderName} onCopy={onCopy} />

      {/* Card Number with Brand */}
      {item.cardNumber && (
        <Card variant="default" className="mb-2">
          <Card.Body className="py-3">
            <View className="mb-1.5 flex-row items-center justify-between">
              <Card.Description>Card Number</Card.Description>
              {brandDisplayName && (
                <Chip size="sm" variant="secondary">
                  <Chip.Label>{brandDisplayName}</Chip.Label>
                </Chip>
              )}
            </View>
            <View className="flex-row items-center gap-2.5">
              <StyledCreditCard size={16} className="text-muted" />
              <Card.Title
                className="flex-1 font-mono font-normal text-base"
                selectable
                numberOfLines={1}
              >
                {showCardNumber
                  ? formatCardNumber(item.cardNumber)
                  : maskValue(item.cardNumber, 4)}
              </Card.Title>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => setShowCardNumber(!showCardNumber)}
              >
                {showCardNumber ? (
                  <StyledEyeOff size={18} className="text-muted" />
                ) : (
                  <StyledEye size={18} className="text-muted" />
                )}
              </Button>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => onCopy(item.cardNumber ?? "", "Card Number")}
              >
                <StyledCopy size={18} className="text-muted" />
              </Button>
            </View>
          </Card.Body>
        </Card>
      )}

      <FieldRow label="Expiry Date" value={item.expiryDate} onCopy={onCopy} />
      <FieldRow
        label="CVV"
        value={item.cvv}
        onCopy={onCopy}
        options={{
          masked: true,
          showState: showCvv,
          setShowState: setShowCvv,
        }}
      />
      <FieldRow label="Billing Address" value={item.billingAddress} onCopy={onCopy} />
    </>
  );
}
