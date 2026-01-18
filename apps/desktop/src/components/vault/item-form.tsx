import { CreditCardForm, type CreditCardFormData } from "./item-categories/credit-card-form";
import { LoginForm, type LoginFormData } from "./item-categories/login-form";
import { SecureNoteForm, type SecureNoteFormData } from "./item-categories/secure-note-form";
import type { VaultOption } from "./types";

export type { CreditCardFormData, LoginFormData, SecureNoteFormData };
export type { CustomField, VaultOption } from "./types";

interface ItemFormProps {
  category: "login" | "secure-note" | "credit-card" | "identity";
  initialData?: Partial<
    LoginFormData | SecureNoteFormData | CreditCardFormData
  >;
  onSubmit: (
    data: LoginFormData | SecureNoteFormData | CreditCardFormData,
    vaultId: string,
  ) => Promise<void> | void;
  onCancel: () => void;
  submitLabel?: string;
  isSubmitting?: boolean;
  vaults?: VaultOption[];
  selectedVaultId?: string;
}

export function ItemForm(props: ItemFormProps) {
  if (props.category === "login") {
    return (
      <LoginForm
        initialData={props.initialData as Partial<LoginFormData>}
        onSubmit={props.onSubmit}
        onCancel={props.onCancel}
        submitLabel={props.submitLabel}
        isSubmitting={props.isSubmitting}
        vaults={props.vaults}
        selectedVaultId={props.selectedVaultId}
      />
    );
  }
  if (props.category === "credit-card") {
    return (
      <CreditCardForm
        initialData={props.initialData as Partial<CreditCardFormData>}
        onSubmit={props.onSubmit}
        onCancel={props.onCancel}
        submitLabel={props.submitLabel}
        isSubmitting={props.isSubmitting}
        vaults={props.vaults}
        selectedVaultId={props.selectedVaultId}
      />
    );
  }
  if (props.category === "identity") {
    return <div>Identity form not implemented yet.</div>;
  }
  return (
    <SecureNoteForm
      initialData={props.initialData as Partial<SecureNoteFormData>}
      onSubmit={props.onSubmit}
      onCancel={props.onCancel}
      submitLabel={props.submitLabel}
      isSubmitting={props.isSubmitting}
      vaults={props.vaults}
      selectedVaultId={props.selectedVaultId}
    />
  );
}
