"use client";

import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import { motion } from "framer-motion";
import {
	AlertTriangle,
	Blocks,
	Bot,
	ChevronsUpDown,
	CircleHelp,
	Code2,
	FileClock,
	FolderKanban,
	GraduationCap,
	ImageIcon,
	Layout,
	LayoutDashboard,
	LogOut,
	Megaphone,
	MessageSquareText,
	MessagesSquare,
	Plug,
	Plus,
	Settings,
	Settings2,
	SquareCheckBig,
	UserCircle,
	UserCog,
	UserSearch,
	Workflow,
	Zap,
	Brain,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type Tab =
	| "dashboard"
	| "chats"
	| "deals"
	| "prompts"
	| "automations"
	| "contacts"
	| "analytics"
	| "fallas"
	| "settings";

interface SidebarProps {
	activeTab: Tab;
	setActiveTab: (tab: Tab) => void;
	phone?: string | null;
	botProfile?: SidebarBotProfile | null;
	onDisconnect?: () => void;
}

type WhatsAppInstance = {
	id: number;
	name: string;
	phone: string | null;
	status: "disconnected" | "qr" | "connecting" | "connected";
	is_active: boolean;
};

type SidebarBotProfile = {
	profile_picture_url: string | null;
	business?: {
		description?: string | null;
		name?: string | null;
		category?: string | null;
	} | null;
	phone?: string | null;
	name?: string | null;
};

type ExistingNavItem = {
	type: "tab";
	value: Tab;
	label: string;
	icon: ComponentType<{ className?: string }>;
	badge?: string;
};

type PlaceholderNavItem = {
	type: "placeholder";
	label: string;
	icon: ComponentType<{ className?: string }>;
	badge?: string;
};

type NavItem = ExistingNavItem | PlaceholderNavItem;

const sidebarVariants = {
	open: { width: "15rem" },
	closed: { width: "3.05rem" },
};

const contentVariants = {
	open: { display: "block", opacity: 1 },
	closed: { display: "block", opacity: 1 },
};

const labelVariants = {
	open: {
		x: 0,
		opacity: 1,
		transition: { x: { stiffness: 1000, velocity: -100 } },
	},
	closed: {
		x: -20,
		opacity: 0,
		transition: { x: { stiffness: 100 } },
	},
};

const transitionProps = {
	type: "tween",
	ease: "easeOut",
	duration: 0.2,
	staggerChildren: 0.1,
} as const;

const staggerVariants = {
	open: {
		transition: { staggerChildren: 0.03, delayChildren: 0.02 },
	},
};

const primaryItems: NavItem[] = [
	{ type: "tab", value: "dashboard", label: "Dashboard", icon: LayoutDashboard },
	{ type: "tab", value: "analytics", label: "Analytics", icon: FileClock },
	{ type: "tab", value: "chats", label: "Conversaciones", icon: MessagesSquare },
	{ type: "placeholder", label: "Campaigns", icon: Megaphone, badge: "DEV" },
];

const workspaceItems: NavItem[] = [
	{ type: "tab", value: "deals", label: "Deals", icon: Layout },
	{ type: "tab", value: "contacts", label: "Contactos CRM", icon: UserCircle },
	{ type: "tab", value: "fallas", label: "Reportes de fallas", icon: AlertTriangle },
	{ type: "placeholder", label: "Competitors", icon: UserSearch },
	{ type: "placeholder", label: "Integrations", icon: Plug, badge: "DEV" },
	{ type: "placeholder", label: "Manage", icon: Settings2, badge: "DEV" },
	{ type: "placeholder", label: "Gallery", icon: ImageIcon, badge: "DEV" },
];

const libraryItems: NavItem[] = [
	{ type: "tab", value: "prompts", label: "AI Prompts", icon: Brain },
	{ type: "tab", value: "automations", label: "Automatizaciones", icon: Zap },
	{ type: "placeholder", label: "FAQ Bot", icon: CircleHelp, badge: "DEV" },
	{ type: "placeholder", label: "Chatbot", icon: Bot, badge: "DEV" },
	{ type: "placeholder", label: "AI Assistant", icon: Brain, badge: "DEV" },
	{ type: "placeholder", label: "Flows", icon: Workflow, badge: "DEV" },
	{ type: "placeholder", label: "Projects", icon: FolderKanban, badge: "DEV" },
	{ type: "placeholder", label: "Tasks", icon: SquareCheckBig, badge: "DEV" },
	{ type: "placeholder", label: "Knowledge Base", icon: GraduationCap },
	{ type: "placeholder", label: "Developers", icon: Code2, badge: "DEV" },
	{ type: "placeholder", label: "Feedback", icon: MessageSquareText },
	{ type: "placeholder", label: "Document Review", icon: FileClock },
];

function SidebarItem({
	item,
	activeTab,
	isCollapsed,
	setActiveTab,
}: {
	item: NavItem;
	activeTab: Tab;
	isCollapsed: boolean;
	setActiveTab: (tab: Tab) => void;
}) {
	const Icon = item.icon;
	const isActive = item.type === "tab" && activeTab === item.value;

	return (
		<button
			type="button"
			onClick={() => item.type === "tab" && setActiveTab(item.value)}
			aria-current={isActive ? "page" : undefined}
			className={cn(
				"flex h-8 w-full flex-row items-center rounded-md px-2 py-1.5 text-muted-foreground transition hover:bg-muted hover:text-primary",
				isActive && "bg-muted text-primary",
				item.type === "placeholder" && "cursor-default opacity-70 hover:text-muted-foreground",
			)}
		>
			<Icon className="size-4 shrink-0" />
			<motion.span variants={labelVariants} className="min-w-0">
				{!isCollapsed && (
					<span className="ml-2 flex items-center gap-2 truncate text-sm font-medium">
						{item.label}
						{item.badge && (
							<Badge variant="outline" className="h-fit border-primary/30 bg-primary/10 px-1.5 text-primary">
								{item.badge}
							</Badge>
						)}
					</span>
				)}
			</motion.span>
		</button>
	);
}

function SidebarSection({
	items,
	activeTab,
	isCollapsed,
	setActiveTab,
}: {
	items: NavItem[];
	activeTab: Tab;
	isCollapsed: boolean;
	setActiveTab: (tab: Tab) => void;
}) {
	return (
		<div className="flex w-full flex-col gap-1">
			{items.map((item) => (
				<SidebarItem
					key={item.label}
					item={item}
					activeTab={activeTab}
					isCollapsed={isCollapsed}
					setActiveTab={setActiveTab}
				/>
			))}
		</div>
	);
}

export default function Sidebar({
	activeTab,
	setActiveTab,
	phone,
	botProfile,
	onDisconnect,
}: SidebarProps) {
	const [isCollapsed, setIsCollapsed] = useState(true);
	const [organizationMenuOpen, setOrganizationMenuOpen] = useState(false);
	const [accountMenuOpen, setAccountMenuOpen] = useState(false);
	const [avatarFailed, setAvatarFailed] = useState(false);
	const [instances, setInstances] = useState<WhatsAppInstance[]>([]);
	const [newInstanceName, setNewInstanceName] = useState("");
	const [instanceBusy, setInstanceBusy] = useState(false);
	const [instanceError, setInstanceError] = useState<string | null>(null);
	const activeInstance = instances.find((instance) => instance.is_active) ?? null;
	const appLabel = "WOpen";
	const configuredPhone = phone || botProfile?.phone || activeInstance?.phone || null;
	const accountLabel = configuredPhone ? `+${configuredPhone}` : "Sin WhatsApp conectado";
	const rawWhatsAppLabel =
		botProfile?.business?.name?.trim() ||
		botProfile?.name?.trim() ||
		activeInstance?.name?.trim() ||
		"";
	const normalizedRawWhatsAppLabel = rawWhatsAppLabel.replace(/^\+/, "").trim();
	const normalizedPhoneLabel = (configuredPhone || "").replace(/^\+/, "").trim();
	const whatsappLabel =
		normalizedRawWhatsAppLabel && normalizedRawWhatsAppLabel !== normalizedPhoneLabel
			? rawWhatsAppLabel
			: appLabel;

	const loadInstances = async () => {
		try {
			const res = await fetch("/api/instances", { cache: "no-store" });
			if (!res.ok) throw new Error("No se pudieron cargar las instancias");
			setInstances(await res.json());
			setInstanceError(null);
		} catch (error: any) {
			setInstanceError(error.message || "Error cargando instancias");
		}
	};

	useEffect(() => {
		if (organizationMenuOpen) void loadInstances();
	}, [organizationMenuOpen]);

	const activateInstance = async (id: number, reload = true) => {
		setInstanceBusy(true);
		try {
			const res = await fetch(`/api/instances/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ active: true }),
			});
			if (!res.ok) throw new Error("No se pudo activar la instancia");
			await loadInstances();
			if (reload) window.location.reload();
		} catch (error: any) {
			setInstanceError(error.message || "Error activando instancia");
		} finally {
			setInstanceBusy(false);
		}
	};

	const createInstance = async () => {
		const name = newInstanceName.trim();
		if (!name || instanceBusy) return;
		setInstanceBusy(true);
		try {
			const res = await fetch("/api/instances", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name }),
			});
			if (!res.ok) throw new Error("No se pudo crear la instancia");
			const created = await res.json();
			setNewInstanceName("");
			await activateInstance(created.id, true);
		} catch (error: any) {
			setInstanceError(error.message || "Error creando instancia");
			setInstanceBusy(false);
		}
	};

	const deleteInstance = async (id: number) => {
		if (instanceBusy || !confirm("Eliminar esta instancia de WhatsApp?")) return;
		setInstanceBusy(true);
		try {
			const res = await fetch(`/api/instances/${id}`, { method: "DELETE" });
			if (!res.ok) throw new Error("No se pudo eliminar la instancia");
			await loadInstances();
			window.location.reload();
		} catch (error: any) {
			setInstanceError(error.message || "Error eliminando instancia");
		} finally {
			setInstanceBusy(false);
		}
	};

	const handleLogout = async () => {
		await fetch("/api/auth/logout", { method: "POST" });
		window.location.href = "/login";
	};

	return (
		<motion.nav
			className="fixed left-0 top-0 z-50 h-screen shrink-0 border-r border-outline-variant/30 shadow-[20px_0_60px_rgba(12,83,58,0.14)] backdrop-blur-xl"
			initial={isCollapsed ? "closed" : "open"}
			animate={isCollapsed ? "closed" : "open"}
			variants={sidebarVariants}
			transition={transitionProps}
			onMouseEnter={() => setIsCollapsed(false)}
			onMouseLeave={() => {
				setIsCollapsed(true);
				setOrganizationMenuOpen(false);
				setAccountMenuOpen(false);
			}}
			aria-label="Main navigation"
		>
			<motion.div
				className="relative z-40 flex h-full shrink-0 flex-col bg-surface/95 text-muted-foreground transition-all"
				variants={contentVariants}
			>
				<motion.div variants={staggerVariants} className="flex h-full flex-col">
					<div className="flex grow flex-col items-center">
						<div className="flex h-[54px] w-full shrink-0 border-b border-outline-variant/30 p-2">
							<div className="mt-[1.5px] flex w-full">
								<DropdownMenu
									modal={false}
									open={organizationMenuOpen}
									onOpenChange={setOrganizationMenuOpen}
								>
									<DropdownMenuTrigger className="w-full" asChild>
										<Button variant="ghost" size="sm" className="flex w-fit items-center gap-2 px-2">
											<Avatar className="size-4 rounded">
												<AvatarImage src="/logoWOPEN.png" alt="WOpen" />
												<AvatarFallback className="rounded bg-primary text-[10px] text-on-primary">
													W
												</AvatarFallback>
											</Avatar>
											<motion.span variants={labelVariants} className="flex w-fit items-center gap-2">
												{!isCollapsed && (
													<>
													<span className="text-sm font-medium">{appLabel}</span>
														<ChevronsUpDown className="size-4 text-muted-foreground/50" />
													</>
												)}
											</motion.span>
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start" className="w-80 p-2">
										<div className="px-2 py-1 text-xs font-semibold text-primary">WhatsApp instances</div>
										<div className="space-y-1 py-1">
											{instances.map((instance) => (
												<div key={instance.id} className="flex items-center justify-between gap-2 rounded-md border border-outline-variant/40 bg-surface px-2 py-2">
													<div className="min-w-0">
														<div className="truncate text-xs font-semibold text-primary">{instance.name}</div>
														<div className="text-[10px] text-muted-foreground">
															{instance.is_active ? "Active" : instance.status} {instance.phone ? `+${instance.phone}` : ""}
														</div>
													</div>
													<div className="flex shrink-0 items-center gap-1">
														{!instance.is_active && (
															<button type="button" disabled={instanceBusy} onClick={() => activateInstance(instance.id)} className="rounded border border-primary/40 px-2 py-1 text-[10px] font-bold text-primary hover:bg-primary/10">Use</button>
														)}
														<button type="button" disabled={instanceBusy || instances.length <= 1} onClick={() => deleteInstance(instance.id)} className="rounded border border-error/40 px-2 py-1 text-[10px] font-bold text-error hover:bg-error/10">Delete</button>
													</div>
												</div>
											))}
											{instances.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">No instances yet.</div>}
										</div>
										<DropdownMenuSeparator />
										<div className="space-y-2 p-2">
											<div className="flex items-center gap-2 text-xs font-semibold text-primary"><Plus className="size-4" /> Create or join</div>
											<input
												value={newInstanceName}
												onChange={(event) => setNewInstanceName(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === "Enter") void createInstance();
												}}
												placeholder="New instance name"
												className="w-full rounded-md border border-outline-variant bg-background px-2 py-1.5 text-xs text-primary outline-none focus:border-primary/60"
											/>
											<button type="button" disabled={instanceBusy || !newInstanceName.trim()} onClick={createInstance} className="w-full rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-on-primary disabled:opacity-50">
												Create and connect
											</button>
											{instanceError && <p className="text-[10px] text-error">{instanceError}</p>}
										</div>
										<DropdownMenuSeparator />
										<DropdownMenuItem disabled className="flex items-center gap-2">
											<UserCog className="size-4" /> Manage members
										</DropdownMenuItem>
										<DropdownMenuItem disabled className="flex items-center gap-2">
											<Blocks className="size-4" /> Integrations
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</div>

						<div className="flex h-full w-full flex-col">
							<div className="flex grow flex-col gap-4">
								<ScrollArea className="h-16 grow p-2">
									<div className="flex w-full flex-col gap-2">
										<SidebarSection
											items={primaryItems}
											activeTab={activeTab}
											isCollapsed={isCollapsed}
											setActiveTab={setActiveTab}
										/>
										<Separator className="w-full" />
										<SidebarSection
											items={workspaceItems}
											activeTab={activeTab}
											isCollapsed={isCollapsed}
											setActiveTab={setActiveTab}
										/>
										<Separator className="w-full" />
										<SidebarSection
											items={libraryItems}
											activeTab={activeTab}
											isCollapsed={isCollapsed}
											setActiveTab={setActiveTab}
										/>
									</div>
								</ScrollArea>
							</div>

							<div className="flex flex-col p-2">
								<button
									type="button"
									onClick={() => setActiveTab("settings")}
									className={cn(
										"mt-auto flex h-8 w-full flex-row items-center rounded-md px-2 py-1.5 text-muted-foreground transition hover:bg-muted hover:text-primary",
										activeTab === "settings" && "bg-muted text-primary",
									)}
								>
									<Settings className="size-4 shrink-0" />
									<motion.span variants={labelVariants}>
										{!isCollapsed && <span className="ml-2 text-sm font-medium">Ajustes</span>}
									</motion.span>
								</button>

								<DropdownMenu
									modal={false}
									open={accountMenuOpen}
									onOpenChange={setAccountMenuOpen}
								>
									<DropdownMenuTrigger className="w-full">
										<div className="flex h-8 w-full flex-row items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-muted hover:text-primary">
											<Avatar className="size-4">
												{botProfile?.profile_picture_url && !avatarFailed && (
													<AvatarImage
														src={botProfile.profile_picture_url}
														alt="Bot avatar"
														onError={() => setAvatarFailed(true)}
													/>
												)}
												<AvatarFallback className="text-[10px]">
													W
												</AvatarFallback>
											</Avatar>
											<motion.span variants={labelVariants} className="flex w-full min-w-0 items-center gap-2">
												{!isCollapsed && (
													<>
														<span className="truncate text-sm font-medium">{accountLabel}</span>
														<ChevronsUpDown className="ml-auto size-4 shrink-0 text-muted-foreground/50" />
													</>
												)}
											</motion.span>
										</div>
									</DropdownMenuTrigger>
									<DropdownMenuContent sideOffset={5}>
										<div className="flex flex-row items-center gap-2 p-2">
											<Avatar className="size-6">
												{botProfile?.profile_picture_url && !avatarFailed && (
													<AvatarImage src={botProfile.profile_picture_url} alt="Bot avatar" />
												)}
												<AvatarFallback>
													W
												</AvatarFallback>
											</Avatar>
											<div className="flex flex-col text-left">
												<span className="text-sm font-medium">{whatsappLabel}</span>
												<span className="line-clamp-1 text-xs text-muted-foreground">{accountLabel}</span>
											</div>
										</div>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											className="flex items-center gap-2"
											onSelect={() => setActiveTab("settings")}
										>
											<UserCircle className="size-4" /> Perfil
										</DropdownMenuItem>
										{onDisconnect && (
											<DropdownMenuItem className="flex items-center gap-2" onSelect={onDisconnect}>
												<LogOut className="size-4" /> Desconectar WhatsApp
											</DropdownMenuItem>
										)}
										<DropdownMenuItem className="flex items-center gap-2" onSelect={handleLogout}>
											<LogOut className="size-4" /> Cerrar sesión
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</div>
					</div>
				</motion.div>
			</motion.div>
		</motion.nav>
	);
}

