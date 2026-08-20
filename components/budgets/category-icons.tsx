import * as Icons from "lucide-react";
import { createElement } from "react";
import type { LucideIcon } from "lucide-react";

export const CATEGORY_ICON_OPTIONS = [
  "Wallet",
  "Coins",
  "Banknote",
  "Bitcoin",
  "CreditCard",
  "CircleDollarSign",
  "DollarSign",
  "BadgeDollarSign",
  "PiggyBank",
  "Landmark",
  "Home",
  "Building2",
  "KeyRound",
  "ShoppingCart",
  "ShoppingBag",
  "ShoppingBasket",
  "Store",
  "UtensilsCrossed",
  "ChefHat",
  "Coffee",
  "Apple",
  "Car",
  "Bus",
  "Plane",
  "Bike",
  "Fuel",
  "Zap",
  "Lightbulb",
  "Wifi",
  "Phone",
  "Heart",
  "Stethoscope",
  "Pill",
  "BookOpen",
  "GraduationCap",
  "BriefcaseBusiness",
  "Gift",
  "Gamepad2",
  "Film",
  "Music",
  "Dumbbell",
  "Dog",
  "Cat",
  "Flower2",
  "TreePine",
  "Globe2",
  "Rocket",
  "TrendingUp",
] as const;

export type CategoryIconName = (typeof CATEGORY_ICON_OPTIONS)[number];

type IconProps = {
  className?: string;
  style?: React.CSSProperties;
  "aria-hidden"?: boolean;
};

const ICONS = Icons as unknown as Record<string, LucideIcon>;
const CATEGORY_ICON_NAMES = new Set<string>(CATEGORY_ICON_OPTIONS);

export function resolveCategoryIcon(name: string | null | undefined): LucideIcon {
  if (!name || !CATEGORY_ICON_NAMES.has(name)) return Icons.Wallet;
  return ICONS[name] ?? Icons.Wallet;
}

export function CategoryIcon({
  name,
  color,
  className = "h-4 w-4",
}: {
  name: string | null | undefined;
  color?: string;
  className?: string;
}) {
  const Icon = resolveCategoryIcon(name);
  const props: IconProps = {
    className,
    "aria-hidden": true,
    ...(color ? { style: { color } } : {}),
  };
  return createElement(Icon, props);
}
