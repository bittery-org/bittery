import { useVaultItems } from "@bittery/hooks";
import {
  detectCardBrand,
  formatCardNumber as formatCardNumberUtil,
  getCardBrandDisplayName,
} from "@bittery/shared/credit-card";
import type { ItemCategory } from "@bittery/shared/types";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Card, Chip, Skeleton, useToast } from "heroui-native";
import {
  ArrowLeft,
  Copy,
  CreditCard,
  Edit,
  Eye,
  EyeOff,
  Globe,
  Key,
  Mail,
  Star,
  User,
} from "lucide-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { withUniwind } from "uniwind";
import { ItemIcon } from "@/components/item-icon";
import { SafeAreaView } from "@/components/safe-area-view";
import { TotpDisplay } from "../../../src/components/totp-display";

// Create styled icon components
const StyledArrowLeft = withUniwind(ArrowLeft);
const StyledCopy = withUniwind(Copy);
const StyledEdit = withUniwind(Edit);
const StyledEye = withUniwind(Eye);
const StyledEyeOff = withUniwind(EyeOff);
const StyledGlobe = withUniwind(Globe);
const StyledStar = withUniwind(Star);
const StyledCreditCard = withUniwind(CreditCard);

const categoryLabels: Record<ItemCategory, string> = {
  login: "Login",
  "credit-card": "Credit Card",
  identity: "Identity",
  "secure-note": "Secure Note",
  totp: "TOTP",
};

export default function ItemDetailScreen() {
  const router = useRouter();
  const { vaultId, itemId } = useLocalSearchParams<{
    vaultId: string;
    itemId: string;
  }>();

  const { items, isLoading, error } = useVaultItems(vaultId);
  const [showPassword, setShowPassword] = useState(false);
  const [showCardNumber, setShowCardNumber] = useState(false);
  const [showCvv, setShowCvv] = useState(false);
  const [showSsn, setShowSsn] = useState(false);
  const [showTotpSecret, setShowTotpSecret] = useState(false);
  const { toast } = useToast();

  const item = items.find((i) => i.id === itemId);

  const handleCopy = async (value: string, label: string) => {
    await Clipboard.setStringAsync(value);
    toast.show({
      variant: "accent",
      label: "Copied to clipboard",
      description: `${label} has been copied to clipboard.`,
	  placement: 'bottom'
    });
  };

  const maskValue = (value: string, visibleChars = 4) => {
    if (value.length <= visibleChars) return "•".repeat(value.length);
    return "•".repeat(value.length - visibleChars) + value.slice(-visibleChars);
  };

  const formatCardNumber = (number: string) => {
    const brand = detectCardBrand(number);
    return formatCardNumberUtil(number, brand);
  };

  if (isLoading) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        {/* Header Skeleton */}
        <View className="border-border border-b px-4 py-4">
          <View className="flex-row items-center">
            <Skeleton className="mr-3 h-10 w-10 rounded-full" />
            <Skeleton className="mr-3 h-10 w-10 rounded-lg" />
            <View className="flex-1">
              <Skeleton className="mb-2 h-4 w-32 rounded" />
              <Skeleton className="h-3 w-24 rounded" />
            </View>
            <Skeleton className="h-9 w-16 rounded-lg" />
          </View>
        </View>
        {/* Content Skeleton */}
        <ScrollView className="flex-1 px-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <View key={i} className="border-border border-b py-4">
              <Skeleton className="mb-2 h-3 w-20 rounded" />
              <Skeleton className="h-4 w-full rounded" />
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background p-8">
        <Card variant="secondary" className="w-full max-w-sm items-center p-8">
          <Card.Title className="mb-2 text-center text-destructive text-lg">
            Error loading item
          </Card.Title>
          <Card.Description className="mb-4 text-center">
            {error instanceof Error ? error.message : "Unknown error"}
          </Card.Description>
          <Button onPress={() => router.back()} variant="primary">
            Go Back
          </Button>
        </Card>
      </SafeAreaView>
    );
  }

  if (!item) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-background p-8">
        <Card variant="secondary" className="w-full max-w-sm items-center p-8">
          <Card.Title className="mb-4 text-center text-lg">
            Item not found
          </Card.Title>
          <Button onPress={() => router.back()} variant="primary">
            Go Back
          </Button>
        </Card>
      </SafeAreaView>
    );
  }

  const renderFieldRow = (
    label: string,
    value: string | undefined,
    options?: {
      masked?: boolean;
      showState?: boolean;
      setShowState?: (show: boolean) => void;
      icon?: typeof Key;
    },
  ) => {
    if (!value) return null;

    const displayValue =
      options?.masked && !options?.showState ? maskValue(value) : value;

    return (
      <Card variant="default" className="mb-2">
        <Card.Body className="py-1">
          <Card.Description className="mb-1.5">{label}</Card.Description>
          <View className="flex-row items-center gap-2.5">
            {options?.icon && (
              <options.icon size={16} className="text-muted-foreground" />
            )}
            <Card.Title
              className="flex-1 font-normal text-base"
              selectable
              numberOfLines={
                options?.masked && !options?.showState ? 1 : undefined
              }
            >
              {displayValue}
            </Card.Title>
            {options?.masked && options?.setShowState && (
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => options.setShowState?.(!options.showState)}
              >
                {options.showState ? (
                  <StyledEyeOff size={18} className="text-muted-foreground" />
                ) : (
                  <StyledEye size={18} className="text-muted-foreground" />
                )}
              </Button>
            )}
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={() => handleCopy(value, label)}
            >
              <StyledCopy size={18} className="text-muted-foreground" />
            </Button>
          </View>
        </Card.Body>
      </Card>
    );
  };

  const renderLoginFields = () => (
    <>
      {renderFieldRow("Username", item.username, { icon: User })}
      {renderFieldRow("Password", item.password, {
        masked: true,
        showState: showPassword,
        setShowState: setShowPassword,
        icon: Key,
      })}
      {renderFieldRow("Website", item.url, { icon: Globe })}
      {item.urls &&
        item.urls.length > 1 &&
        item.urls.slice(1).map((url, index) => (
          <Card key={url} variant="secondary" className="mb-2">
            <Card.Body className="py-3">
              <Card.Description className="mb-1.5">
                Website {index + 2}
              </Card.Description>
              <View className="flex-row items-center gap-2.5">
                <StyledGlobe size={16} className="text-muted-foreground" />
                <Card.Title className="flex-1 font-normal text-base" selectable>
                  {url}
                </Card.Title>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  onPress={() => handleCopy(url, "URL")}
                >
                  <StyledCopy size={18} className="text-muted-foreground" />
                </Button>
              </View>
            </Card.Body>
          </Card>
        ))}
      {/* TOTP Section for Login Items */}
      {item.totpSecret && (
        <Card variant="secondary" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-2">
              Two-Factor Code
            </Card.Description>
            <TotpDisplay
              totpSecret={item.totpSecret}
              totpAlgorithm={item.totpAlgorithm}
              totpDigits={item.totpDigits}
              totpPeriod={item.totpPeriod}
              label={item.totpIssuer || "One-time password"}
            />
          </Card.Body>
        </Card>
      )}
    </>
  );

  const renderCreditCardFields = () => {
    const cardBrand = item.cardNumber ? detectCardBrand(item.cardNumber) : null;
    const brandDisplayName =
      cardBrand && cardBrand !== "unknown"
        ? getCardBrandDisplayName(cardBrand)
        : null;

    return (
      <>
        {renderFieldRow("Cardholder Name", item.cardholderName)}
        {item.cardNumber && (
          <Card variant="secondary" className="mb-2">
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
                <StyledCreditCard size={16} className="text-muted-foreground" />
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
                    <StyledEyeOff size={18} className="text-muted-foreground" />
                  ) : (
                    <StyledEye size={18} className="text-muted-foreground" />
                  )}
                </Button>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    handleCopy(item.cardNumber ?? "", "Card Number")
                  }
                >
                  <StyledCopy size={18} className="text-muted-foreground" />
                </Button>
              </View>
            </Card.Body>
          </Card>
        )}
        {renderFieldRow("Expiry Date", item.expiryDate)}
        {renderFieldRow("CVV", item.cvv, {
          masked: true,
          showState: showCvv,
          setShowState: setShowCvv,
        })}
        {renderFieldRow("Billing Address", item.billingAddress)}
      </>
    );
  };

  const renderIdentityFields = () => (
    <>
      {(item.firstName || item.lastName) && (
        <Card variant="secondary" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-1.5">Name</Card.Description>
            <Card.Title className="font-normal text-base" selectable>
              {[item.firstName, item.middleName, item.lastName]
                .filter(Boolean)
                .join(" ")}
            </Card.Title>
          </Card.Body>
        </Card>
      )}
      {renderFieldRow("Email", item.email, { icon: Mail })}
      {renderFieldRow("Date of Birth", item.dateOfBirth)}
      {renderFieldRow("SSN", item.ssn, {
        masked: true,
        showState: showSsn,
        setShowState: setShowSsn,
      })}
      {renderFieldRow("Passport Number", item.passportNumber)}
      {renderFieldRow("Driver's License", item.driversLicense)}
      {item.addresses?.map((address, index) => (
        <Card key={`address-${index}`} variant="secondary" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-1.5">
              {address.city} {address.country}
            </Card.Description>
            <Card.Title className="font-normal text-base" selectable>
              {[
                address.street,
                address.city,
                address.state,
                address.zip,
                address.country,
              ]
                .filter(Boolean)
                .join(", ")}
            </Card.Title>
          </Card.Body>
        </Card>
      ))}
      {item.phoneNumbers?.map((phone, index) => (
        <Card key={`phone-${index}`} variant="secondary" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-1.5">
              {phone.label || `Phone ${index + 1}`}
            </Card.Description>
            <View className="flex-row items-center gap-2.5">
              <Card.Title className="flex-1 font-normal text-base" selectable>
                {phone.number}
              </Card.Title>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => handleCopy(phone.number, "Phone")}
              >
                <StyledCopy size={18} className="text-muted-foreground" />
              </Button>
            </View>
          </Card.Body>
        </Card>
      ))}
    </>
  );

  const renderSecureNoteFields = () => (
    <Card variant="secondary" className="mb-2">
      <Card.Body className="py-3">
        <Card.Description className="mb-2">Note</Card.Description>
        <Card.Title className="font-normal text-base" selectable>
          {item.note || item.notes}
        </Card.Title>
      </Card.Body>
    </Card>
  );

  const renderTotpFields = () => (
    <>
      {/* Live TOTP Code Display */}
      {item.totpSecret && (
        <Card variant="secondary" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-2">Current Code</Card.Description>
            <TotpDisplay
              totpSecret={item.totpSecret}
              totpAlgorithm={item.totpAlgorithm}
              totpDigits={item.totpDigits}
              totpPeriod={item.totpPeriod}
            />
          </Card.Body>
        </Card>
      )}
      {renderFieldRow("Secret", item.totpSecret, {
        masked: true,
        showState: showTotpSecret,
        setShowState: setShowTotpSecret,
      })}
      {renderFieldRow("Issuer", item.totpIssuer)}
      {renderFieldRow("Account", item.totpAccountName)}
      {/* Show TOTP settings if non-default */}
      {item.totpAlgorithm && item.totpAlgorithm !== "SHA1" && (
        <Card variant="secondary" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-1.5">Algorithm</Card.Description>
            <Card.Title className="font-normal text-base">
              {item.totpAlgorithm}
            </Card.Title>
          </Card.Body>
        </Card>
      )}
      {item.totpDigits && item.totpDigits !== 6 && (
        <Card variant="secondary" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-1.5">Digits</Card.Description>
            <Card.Title className="font-normal text-base">
              {item.totpDigits}
            </Card.Title>
          </Card.Body>
        </Card>
      )}
      {item.totpPeriod && item.totpPeriod !== 30 && (
        <Card variant="secondary" className="mb-2">
          <Card.Body className="py-3">
            <Card.Description className="mb-1.5">Period</Card.Description>
            <Card.Title className="font-normal text-base">
              {item.totpPeriod} seconds
            </Card.Title>
          </Card.Body>
        </Card>
      )}
    </>
  );

  return (
    <SafeAreaView className="flex-1 bg-background">
      {/* Header */}
      <View className="flex-row items-center border-border border-b px-4 py-4">
        <Button
          isIconOnly
          size="sm"
          variant="secondary"
          onPress={() => router.back()}
          className="mr-3"
        >
          <StyledArrowLeft size={20} className="text-muted-foreground" />
        </Button>
        <ItemIcon category={item.category} url={item.url} size="md" className="mr-3" />
        <View className="flex-1">
          <View className="flex-row items-center">
            <Card.Title className="text-base">{item.title}</Card.Title>
            {item.favorite && (
              <StyledStar
                size={14}
                fill="#eab308"
                className="ml-2 text-yellow-500"
              />
            )}
          </View>
          <Card.Description className="text-sm">
            {categoryLabels[item.category]}
          </Card.Description>
        </View>
        <Button
          variant="primary"
          size="sm"
          onPress={() => router.push(`/(vault)/${vaultId}/edit/${itemId}`)}
        >
          <StyledEdit size={16} className="text-accent-foreground" />
          <Button.Label>Edit</Button.Label>
        </Button>
      </View>

      <ScrollView className="flex-1 px-4 pt-4">
        {/* Category-specific fields */}
        {item.category === "login" && renderLoginFields()}
        {item.category === "credit-card" && renderCreditCardFields()}
        {item.category === "identity" && renderIdentityFields()}
        {item.category === "secure-note" && renderSecureNoteFields()}
        {item.category === "totp" && renderTotpFields()}

        {/* Notes (for non-secure-note items) */}
        {item.category !== "secure-note" && (item.notes || item.note) && (
          <Card variant="secondary" className="mb-2">
            <Card.Body className="py-3">
              <Card.Description className="mb-2">Notes</Card.Description>
              <Card.Title className="font-normal text-base" selectable>
                {item.notes || item.note}
              </Card.Title>
            </Card.Body>
          </Card>
        )}

        {/* Tags */}
        {item.tags && item.tags.length > 0 && (
          <Card variant="secondary" className="mb-2">
            <Card.Body className="py-3">
              <Card.Description className="mb-2">Tags</Card.Description>
              <View className="flex-row flex-wrap gap-2">
                {item.tags.map((tag) => (
                  <Chip key={tag} size="sm" variant="secondary">
                    <Chip.Label>{tag}</Chip.Label>
                  </Chip>
                ))}
              </View>
            </Card.Body>
          </Card>
        )}

        {/* Custom Fields */}
        {item.customFields?.map((field) => (
          <Card key={field.id} variant="secondary" className="mb-2">
            <Card.Body className="py-3">
              <Card.Description className="mb-1.5">
                {field.label}
              </Card.Description>
              <View className="flex-row items-center gap-2.5">
                <Card.Title
                  className="flex-1 font-normal text-base"
                  selectable
                  numberOfLines={field.type === "password" ? 1 : undefined}
                >
                  {field.type === "password"
                    ? maskValue(field.value)
                    : field.value}
                </Card.Title>
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  onPress={() => handleCopy(field.value, field.label)}
                >
                  <StyledCopy size={18} className="text-muted-foreground" />
                </Button>
              </View>
            </Card.Body>
          </Card>
        ))}

        {/* Metadata */}
        <Card variant="transparent" className="mb-4">
          <Card.Body className="py-3">
            <Card.Description className="text-xs">
              Created: {new Date(item.createdAt).toLocaleString()}
            </Card.Description>
            <Card.Description className="text-xs">
              Updated: {new Date(item.updatedAt).toLocaleString()}
            </Card.Description>
          </Card.Body>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}
