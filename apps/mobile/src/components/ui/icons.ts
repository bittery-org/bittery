/**
 * The only place `lucide-react-native` may be imported. Every icon is wrapped
 * with `withUniwind` once here so call sites can colour it with `className`.
 */
import {
	AlertCircle,
	ArchiveRestore,
	ArrowLeft,
	ArrowUpDown,
	Bell,
	Briefcase,
	Camera,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	CircleHelp,
	ClipboardPaste,
	Clock,
	Copy,
	CreditCard,
	Download,
	Edit,
	ExternalLink,
	Eye,
	EyeOff,
	File,
	FileText,
	Filter,
	Fingerprint,
	Flashlight,
	FlashlightOff,
	FolderClosed,
	Globe,
	Grid3x3,
	Heart,
	History,
	Home,
	Info,
	Key,
	KeyRound,
	Languages,
	Library,
	Link,
	ListFilter,
	Loader2,
	Lock,
	LogOut,
	Mail,
	Moon,
	MoreVertical,
	Paperclip,
	Pencil,
	Plus,
	QrCode,
	RefreshCw,
	RotateCcw,
	ScanFace,
	Search,
	Server,
	Settings,
	Share2,
	Shield,
	ShieldCheck,
	Sparkles,
	Star,
	Sun,
	Tag,
	Timer,
	Trash2,
	TriangleAlert,
	User,
	UserPlus,
	Users,
	Vault,
	X,
} from "lucide-react-native";
import { withUniwind } from "uniwind";

export const IconAlertCircle = withUniwind(AlertCircle);
export const IconArchiveRestore = withUniwind(ArchiveRestore);
export const IconArrowLeft = withUniwind(ArrowLeft);
export const IconArrowUpDown = withUniwind(ArrowUpDown);
export const IconBell = withUniwind(Bell);
export const IconBriefcase = withUniwind(Briefcase);
export const IconCamera = withUniwind(Camera);
export const IconCheck = withUniwind(Check);
export const IconChevronDown = withUniwind(ChevronDown);
export const IconChevronLeft = withUniwind(ChevronLeft);
export const IconChevronRight = withUniwind(ChevronRight);
export const IconChevronUp = withUniwind(ChevronUp);
export const IconCircleHelp = withUniwind(CircleHelp);
export const IconClipboardPaste = withUniwind(ClipboardPaste);
export const IconClock = withUniwind(Clock);
export const IconCopy = withUniwind(Copy);
export const IconCreditCard = withUniwind(CreditCard);
export const IconDownload = withUniwind(Download);
export const IconEdit = withUniwind(Edit);
export const IconExternalLink = withUniwind(ExternalLink);
export const IconEye = withUniwind(Eye);
export const IconEyeOff = withUniwind(EyeOff);
export const IconFile = withUniwind(File);
export const IconFileText = withUniwind(FileText);
export const IconFilter = withUniwind(Filter);
export const IconFingerprint = withUniwind(Fingerprint);
export const IconFlashlight = withUniwind(Flashlight);
export const IconFlashlightOff = withUniwind(FlashlightOff);
export const IconFolderClosed = withUniwind(FolderClosed);
export const IconGlobe = withUniwind(Globe);
export const IconGrid = withUniwind(Grid3x3);
export const IconHeart = withUniwind(Heart);
export const IconHistory = withUniwind(History);
export const IconHome = withUniwind(Home);
export const IconInfo = withUniwind(Info);
export const IconKey = withUniwind(Key);
export const IconKeyRound = withUniwind(KeyRound);
export const IconLanguages = withUniwind(Languages);
/** Browse — deliberately not IconVault, which means "a vault" everywhere else. */
export const IconLibrary = withUniwind(Library);
export const IconLink = withUniwind(Link);
export const IconListFilter = withUniwind(ListFilter);
export const IconLoader = withUniwind(Loader2);
export const IconLock = withUniwind(Lock);
export const IconLogOut = withUniwind(LogOut);
export const IconMail = withUniwind(Mail);
export const IconMoon = withUniwind(Moon);
export const IconMoreVertical = withUniwind(MoreVertical);
export const IconPaperclip = withUniwind(Paperclip);
export const IconPencil = withUniwind(Pencil);
export const IconPlus = withUniwind(Plus);
export const IconQrCode = withUniwind(QrCode);
export const IconRefresh = withUniwind(RefreshCw);
export const IconRotateCcw = withUniwind(RotateCcw);
export const IconScanFace = withUniwind(ScanFace);
export const IconSearch = withUniwind(Search);
export const IconServer = withUniwind(Server);
export const IconSettings = withUniwind(Settings);
export const IconShare = withUniwind(Share2);
export const IconShield = withUniwind(Shield);
export const IconShieldCheck = withUniwind(ShieldCheck);
export const IconSparkles = withUniwind(Sparkles);
export const IconStar = withUniwind(Star);
export const IconSun = withUniwind(Sun);
export const IconTag = withUniwind(Tag);
export const IconTimer = withUniwind(Timer);
export const IconTrash = withUniwind(Trash2);
export const IconTriangleAlert = withUniwind(TriangleAlert);
export const IconUser = withUniwind(User);
export const IconUserPlus = withUniwind(UserPlus);
export const IconUsers = withUniwind(Users);
export const IconVault = withUniwind(Vault);
export const IconX = withUniwind(X);

export type AppIcon = typeof IconKey;
