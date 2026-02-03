export interface ItemDetailProps {
  item: any; // Will be typed from useVaultItems
  onCopy: (value: string, label: string) => Promise<void>;
}

export interface FieldRowOptions {
  masked?: boolean;
  showState?: boolean;
  setShowState?: (show: boolean) => void;
  icon?: any;
}
