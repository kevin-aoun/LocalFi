import * as Icons from "lucide-react";
import { createElement } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * The persisted value is the Lucide component name, so keep this list explicit
 * and stable. Existing categories may contain a name added by an older build
 * (or an invalid value), which is why all rendering goes through the resolver.
 */
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

/** Resolve persisted names safely, including names from older or bad data. */
export function resolveCategoryIcon(name: string | null | undefined): LucideIcon {
  if (!name || !CATEGORY_ICON_NAMES.has(name)) return Icons.Wallet;
  return ICONS[name] ?? Icons.Wallet;
}

/** Shared renderer for category cards and the category icon picker. */
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
