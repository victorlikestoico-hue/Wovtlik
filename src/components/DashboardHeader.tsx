"use client";

import Image from "next/image";
import { useState, useEffect } from "react";
import { normalizeProfileStatus } from "@/lib/baileys/profile";
import { SearchIcon, UserIcon, TrashIcon, PlusIcon, PhoneIcon, MailIcon } from "./Icons.tsx";

interface DashboardHeaderProps {
	phone: string | null;
	onDisconnect: () => void;
	botProfile: {
		phone: string;
		profile_picture_url: string | null;
		status: unknown;
		business: {
			description: string;
			category: string;
			email: string;
			website: string[];
			address: string;
		} | null;
	} | null;
	quickReplies: Array<{ id: string; shortcut: string; text: string }>;
	onQuickRepliesUpdated: () => void;
}

export default function DashboardHeader({
	phone,
	onDisconnect,
	botProfile,
	quickReplies,
	onQuickRepliesUpdated,
}: DashboardHeaderProps) {
	const [loading, setLoading] = useState(false);
	const [profileModalOpen, setProfileModalOpen] = useState(false);
	const [zoomImage, setZoomImage] = useState<string | null>(null);
	const [botAvatarError, setBotAvatarError] = useState(false);
	const [prevProfilePicUrl, setPrevProfilePicUrl] = useState(botProfile?.profile_picture_url);
	const profileStatus = normalizeProfileStatus(botProfile?.status);

	const [whisperEnabled, setWhisperEnabled] = useState<boolean | null>(null);
	const [whisperLoading, setWhisperLoading] = useState(false);

	useEffect(() => {
		fetch("/api/monitor-control")
			.then(r => r.json())
			.then((d: { enabled: boolean }) => setWhisperEnabled(d.enabled))
			.catch(() => setWhisperEnabled(false));
	}, []);

	const handleWhisperToggle = async () => {
		if (whisperLoading || whisperEnabled === null) return;
		setWhisperLoading(true);
		try {
			const res = await fetch("/api/monitor-control", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: !whisperEnabled }),
			});
			if (res.ok) {
				const data = await res.json() as { enabled: boolean };
				setWhisperEnabled(data.enabled);
			}
		} catch (err) {
			console.error("[header] Error toggling whisper monitoring:", err);
		} finally {
			setWhisperLoading(false);
		}
	};

	if (botProfile?.profile_picture_url !== prevProfilePicUrl) {
		setPrevProfilePicUrl(botProfile?.profile_picture_url);
		setBotAvatarError(false);
	}

	// Estados del gestor de respuestas rápidas
	const [localQuickReplies, setLocalQuickReplies] = useState<Array<{ id: string; shortcut: string; text: string }>>([]);
	const [newShortcut, setNewShortcut] = useState("");
	const [newText, setNewText] = useState("");
	const [savingReplies, setSavingReplies] = useState(false);

	const handleDisconnect = async () => {
		if (loading || !confirm("¿Estás seguro de que querés desconectar tu WhatsApp? Se cerrará la sesión y tendrás que escanear un nuevo QR.")) return;
		setLoading(true);
		try {
			const res = await fetch("/api/connection/disconnect", { method: "POST" });
			if (res.ok) {
				onDisconnect();
			} else {
				console.error("[header] Error desconectando la sesión.");
			}
		} catch (error) {
			console.error("[header] Error de red desconectando la sesión:", error);
		} finally {
			setLoading(false);
		}
	};

	const handleLogout = async () => {
		if (!confirm("¿Cerrar sesión en el panel?")) return;
		try {
			await fetch("/api/auth/logout", { method: "POST" });
			window.location.href = "/login";
		} catch (error) {
			console.error("[header] Error cerrando sesión:", error);
		}
	};

	// Al abrir el modal, inicializamos el estado local de respuestas rápidas
	const openProfileModal = () => {
		setLocalQuickReplies(quickReplies);
		setNewShortcut("");
		setNewText("");
		setProfileModalOpen(true);
	};

	const handleAddReply = (e: React.FormEvent) => {
		e.preventDefault();
		const normalizedShortcut = newShortcut.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
		if (!normalizedShortcut || !newText.trim()) return;

		// Evitar duplicados
		if (localQuickReplies.some((r) => r.shortcut === normalizedShortcut)) {
			alert("Ya existe una respuesta rápida con este atajo.");
			return;
		}

		const newReply = {
			id: Date.now().toString(),
			shortcut: normalizedShortcut,
			text: newText.trim(),
		};

		setLocalQuickReplies([...localQuickReplies, newReply]);
		setNewShortcut("");
		setNewText("");
	};

	const handleDeleteReply = (id: string) => {
		setLocalQuickReplies(localQuickReplies.filter((r) => r.id !== id));
	};

	const handleSaveReplies = async () => {
		setSavingReplies(true);
		try {
			const res = await fetch("/api/settings", {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					quick_replies: localQuickReplies,
				}),
			});
			if (res.ok) {
				onQuickRepliesUpdated();
				alert("Respuestas rápidas guardadas correctamente.");
			} else {
				console.error("[header] Error guardando respuestas rápidas.");
			}
		} catch (error) {
			console.error("[header] Error de red al guardar respuestas rápidas:", error);
		} finally {
			setSavingReplies(false);
		}
	};

	return (
		<>
			<header className="bg-background border-b border-outline-variant flex justify-end items-center h-16 px-6 shrink-0 z-40">
				
				{/* Status e Interacciones */}
				<div className="flex items-center gap-4">
					
					{/* Search Bar de adorno premium */}
					<div className="relative hidden md:block">
						<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60" size={14} />
						<input
							type="text"
							placeholder="Buscar en el panel...        Ctrl + K"
							aria-label="Buscar en el panel"
							className="bg-surface border border-outline-variant rounded-full pl-8 pr-4 py-1.5 text-xs focus:outline-none focus:border-primary/50 transition-all w-64 placeholder-on-surface-variant/50 text-on-surface"
							disabled
						/>
					</div>

					{phone ? (
						<div className="flex items-center gap-3">
							{/* Badge de Conectado */}
							<div className="flex items-center gap-2 bg-transparent border border-primary text-primary px-4 py-1 rounded-full text-[11px] font-mono shadow-inner">
								<span className="relative flex size-2 shrink-0">
									<span className="animate-ping absolute inline-flex size-2 rounded-full bg-primary opacity-75"></span>
									<span className="relative inline-flex rounded-full size-2 bg-primary"></span>
								</span>
								<span>+{phone}</span>
							</div>

							{/* Botón Monitoreo Whisper */}
							{whisperEnabled !== null && (
								<button
									type="button"
									onClick={handleWhisperToggle}
									disabled={whisperLoading}
									title={whisperEnabled ? "Desactivar monitoreo de whispers" : "Activar monitoreo de whispers"}
									aria-label={whisperEnabled ? "Desactivar monitoreo" : "Activar monitoreo"}
									className={`px-4 py-1 bg-transparent border font-display text-[10px] font-bold uppercase tracking-wider rounded-full transition-all duration-200 active:scale-95 disabled:opacity-50 cursor-pointer ${
										whisperEnabled
											? "border-emerald-500 text-emerald-500 hover:bg-emerald-500/10"
											: "border-outline-variant text-on-surface-variant hover:bg-surface/10"
									}`}
								>
									{whisperLoading ? "..." : whisperEnabled ? "● Monitor ON" : "○ Monitor"}
								</button>
							)}

							{/* Botón Desconectar */}
							<button
								type="button"
								onClick={handleDisconnect}
								disabled={loading}
								className="px-4 py-1 bg-transparent hover:bg-error/10 border border-error text-error font-display text-[10px] font-bold uppercase tracking-wider rounded-full transition-all duration-200 active:scale-95 disabled:opacity-50 cursor-pointer"
								aria-label={loading ? "Desconectando WhatsApp" : "Desconectar WhatsApp"}
							>
								{loading ? "Saliendo..." : "Desconectar"}
							</button>
						</div>
					) : (
						<div className="flex items-center gap-2 bg-error/10 border border-error/20 px-3 py-1 rounded-full text-[11px] text-error font-semibold">
							<span className="size-2 rounded-full bg-error animate-pulse"></span>
							<span>WhatsApp Desconectado</span>
						</div>
					)}

					{/* Perfil */}
					<button 
						type="button"
						onClick={openProfileModal}
						title="Abrir perfil"
						aria-label="Abrir perfil de WhatsApp"
						className="size-8 rounded-full overflow-hidden border border-primary hover:bg-primary/10 transition-colors cursor-pointer flex items-center justify-center bg-transparent"
					>
						{botProfile?.profile_picture_url && !botAvatarError ? (
							<Image
								src={botProfile.profile_picture_url}
								width={32}
								height={32}
								className="size-full object-cover"
								alt="Bot avatar"
								onError={() => setBotAvatarError(true)}
							/>
						) : (
							<UserIcon className="text-primary hover:text-primary transition-colors" size={14} />
						)}
					</button>
				</div>

			</header>

			{/* Modal de Perfil y Respuestas Rápidas */}
			{profileModalOpen && (
				<div 
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
					onClick={() => setProfileModalOpen(false)}
				>
					<div 
						className="relative bg-surface/95 border border-outline-variant rounded-3xl p-6 w-[90vw] max-w-[800px] max-h-[85vh] overflow-y-auto shadow-2xl flex flex-col md:flex-row gap-6 animate-[scaleIn_0.2s_ease-out] backdrop-blur-xl text-on-surface"
						onClick={(e) => e.stopPropagation()}
					>
						{/* Columna Izquierda: Información de Perfil del Bot */}
						<div className="flex-1 flex flex-col gap-4 border-b md:border-b-0 md:border-r border-outline-variant/30 pb-6 md:pb-0 md:pr-6">
							<h3 className="font-display text-sm font-bold text-primary uppercase tracking-wider mb-2">
								Perfil de WhatsApp
							</h3>

							{/* Foto de Perfil */}
							<div className="flex flex-col items-center gap-3">
								<button 
									type="button"
									onClick={() => botProfile?.profile_picture_url && setZoomImage(botProfile.profile_picture_url)}
									aria-label={botProfile?.profile_picture_url ? "Ampliar foto de perfil" : "Foto de perfil no disponible"}
									className={`size-24 rounded-full overflow-hidden border-2 border-primary/50 bg-surface-bright flex items-center justify-center shadow-lg group relative ${botProfile?.profile_picture_url ? "cursor-pointer" : ""}`}
								>
									{botProfile?.profile_picture_url && !botAvatarError ? (
										<>
											<Image 
												src={botProfile.profile_picture_url} 
												alt="Bot profile" 
												fill
												className="size-full object-cover transition-transform duration-300 group-hover:scale-105" 
												onError={() => setBotAvatarError(true)}
											/>
											<div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-[10px] uppercase font-bold tracking-wider transition-opacity duration-200">
												Ampliar
											</div>
										</>
									) : (
										<UserIcon size={36} className="text-primary/70" />
									)}
								</button>
								
								<div className="text-center">
									<p className="font-mono text-sm font-semibold">+{phone}</p>
									{profileStatus && (
										<p className="text-[11px] text-on-surface-variant italic mt-1 bg-surface-bright px-3 py-1 rounded-full border border-outline-variant/35 inline-block">
											"{profileStatus}"
										</p>
									)}
								</div>
							</div>

							{/* Detalles comerciales si aplican */}
							{botProfile?.business ? (
								<div className="mt-4 space-y-3 bg-surface-bright/50 border border-outline-variant/20 rounded-2xl p-4 text-xs">
									<p className="font-semibold text-primary uppercase tracking-wide text-[10px]">
										Perfil de Empresa
									</p>
									
									{botProfile.business.category && (
										<div>
											<span className="text-[9px] font-bold text-on-surface-variant/70 uppercase">Categoría</span>
											<p className="font-medium mt-0.5">{botProfile.business.category}</p>
										</div>
									)}

									{botProfile.business.description && (
										<div>
											<span className="text-[9px] font-bold text-on-surface-variant/70 uppercase">Descripción</span>
											<p className="font-medium mt-0.5 whitespace-pre-wrap">{botProfile.business.description}</p>
										</div>
									)}

									{botProfile.business.email && (
										<div className="flex items-center gap-2 mt-1">
											<MailIcon size={12} className="text-primary/70" />
											<a href={`mailto:${botProfile.business.email}`} className="hover:underline">{botProfile.business.email}</a>
										</div>
									)}

									{botProfile.business.address && (
										<div className="flex items-center gap-2 mt-1">
											<PhoneIcon size={12} className="text-primary/70" />
											<span>{botProfile.business.address}</span>
										</div>
									)}

									{botProfile.business.website && botProfile.business.website.length > 0 && (
										<div className="mt-1">
											<span className="text-[9px] font-bold text-on-surface-variant/70 uppercase block mb-1">Sitios Web</span>
											<div className="flex flex-col gap-1">
												{botProfile.business.website.map((web, idx) => (
													<a 
														key={web} 
														href={web.startsWith("http") ? web : `https://${web}`} 
														target="_blank" 
														rel="noreferrer" 
														className="text-primary hover:underline font-medium break-all block"
													>
														{web}
													</a>
												))}
											</div>
										</div>
									)}
								</div>
							) : (
								<div className="mt-4 text-center p-4 border border-outline-variant/20 rounded-2xl bg-surface-bright/30">
									<p className="text-[10px] text-on-surface-variant/80 uppercase font-semibold">
										Perfil Comercial no configurado
									</p>
									<p className="text-[9px] text-on-surface-variant/60 mt-1">
										WhatsApp detectado como cuenta personal estándar.
									</p>
								</div>
							)}
						</div>

						{/* Columna Derecha: Respuestas Rápidas (/) */}
						<div className="flex-[1.2] flex flex-col gap-4">
							<h3 className="font-display text-sm font-bold text-primary uppercase tracking-wider">
								Respuestas Rápidas (/)
							</h3>

							{/* Lista de Respuestas Rápidas */}
							<div className="flex-1 min-h-[150px] max-h-[250px] overflow-y-auto border border-outline-variant/20 rounded-2xl p-3 bg-surface-bright/40 space-y-2">
								{localQuickReplies.length > 0 ? (
									localQuickReplies.map((reply) => (
										<div 
											key={reply.id} 
											className="flex justify-between items-start gap-3 bg-surface border border-outline-variant/30 p-2.5 rounded-xl text-xs hover:border-primary/45 transition-colors"
										>
											<div className="flex-1 min-w-0">
												<span className="font-mono font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-md border border-primary/20">
													/{reply.shortcut}
												</span>
												<p className="mt-2 text-on-surface-variant leading-relaxed break-words font-medium">
													{reply.text}
												</p>
											</div>
											<button
												type="button"
												onClick={() => handleDeleteReply(reply.id)}
												className="text-error hover:bg-error/10 p-1.5 rounded-full transition-colors cursor-pointer shrink-0"
												title="Eliminar"
												aria-label="Eliminar respuesta rápida"
											>
												<TrashIcon size={14} />
											</button>
										</div>
									))
								) : (
									<div className="h-full flex flex-col items-center justify-center text-on-surface-variant/60 text-center py-8">
										<p className="font-semibold text-xs mb-1">No hay respuestas rápidas</p>
										<p className="text-[10px]">Agrega una abajo usando un atajo que comience con `/` en el chat.</p>
									</div>
								)}
							</div>

							{/* Formulario para agregar una nueva respuesta rápida */}
							<form onSubmit={handleAddReply} className="bg-surface-bright/50 border border-outline-variant/30 rounded-2xl p-4 flex flex-col gap-3">
								<p className="font-semibold uppercase tracking-wide text-[10px] text-primary">
									Nueva Respuesta Rápida
								</p>
								
								<div className="flex items-center gap-2 bg-surface border border-outline-variant rounded-full px-3 py-1.5">
									<span className="text-primary font-mono font-bold">/</span>
									<input 
										type="text" 
										placeholder="atajo (ej. hola)"
										value={newShortcut}
										onChange={(e) => setNewShortcut(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""))}
										className="bg-transparent border-0 outline-none text-xs w-full text-on-surface font-mono"
										required
										aria-label="Atajo de respuesta rápida"
									/>
								</div>

								<textarea 
									placeholder="Texto de la respuesta rápida..."
									value={newText}
									onChange={(e) => setNewText(e.target.value)}
									className="bg-surface border border-outline-variant rounded-xl px-3 py-2 text-xs outline-none focus:border-primary/50 text-on-surface min-h-[60px] resize-none"
									required
									aria-label="Contenido de la respuesta rápida"
								/>

								<button
									type="submit"
									className="py-2 bg-primary text-on-primary text-xs font-bold uppercase tracking-wider rounded-xl transition-all duration-200 active:scale-98 flex items-center justify-center gap-1.5 cursor-pointer shadow-md hover:bg-primary-bright"
								>
									<PlusIcon size={12} />
									Agregar Respuesta
								</button>
							</form>

							{/* Botones de Acción */}
							<div className="flex gap-3 mt-2 shrink-0">
								<button
									type="button"
									onClick={() => setProfileModalOpen(false)}
									className="flex-1 py-2.5 bg-transparent border border-outline-variant hover:bg-surface-bright font-display text-xs font-bold uppercase tracking-wider rounded-xl transition-all duration-200 active:scale-95 cursor-pointer"
								>
									Cerrar
								</button>
								<button
									type="button"
									onClick={handleSaveReplies}
									disabled={savingReplies}
									className="flex-1 py-2.5 bg-primary text-on-primary font-display text-xs font-bold uppercase tracking-wider rounded-xl transition-all duration-200 active:scale-95 hover:bg-primary-bright disabled:opacity-50 cursor-pointer shadow-lg"
								>
									{savingReplies ? "Guardando..." : "Guardar Cambios"}
								</button>
							</div>
						</div>

						{/* Botón de cerrar absoluto para escritorio */}
						<button 
							type="button"
							onClick={() => setProfileModalOpen(false)}
							aria-label="Cerrar modal"
							className="absolute top-4 right-4 text-on-surface-variant hover:text-on-surface size-8 rounded-full flex items-center justify-center hover:bg-surface-bright transition-colors cursor-pointer"
						>
							×
						</button>
					</div>
				</div>
			)}

			{/* Zoom de Imagen */}
			{zoomImage && (
				<div 
					className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm transition-opacity duration-300 animate-fade-in"
					onClick={() => setZoomImage(null)}
				>
					<div 
						className="relative size-[90vw] max-w-[480px] max-h-[480px] p-1.5 bg-surface-container border border-outline-variant/40 rounded-3xl overflow-hidden shadow-2xl flex items-center justify-center animate-[scaleIn_0.2s_ease-out]"
						onClick={(e) => e.stopPropagation()}
					>
						<Image 
							src={zoomImage} 
							alt="Bot foto grande" 
							fill
							className="size-full object-cover rounded-2xl animate-fade-in"
						/>
						<button 
							type="button"
							className="absolute top-4 right-4 size-8 flex items-center justify-center rounded-full bg-black/50 hover:bg-black/70 text-white font-display text-xl font-bold focus:outline-none transition-all duration-200 hover:scale-105 active:scale-95 shadow-md cursor-pointer"
							onClick={() => setZoomImage(null)}
							aria-label="Cerrar zoom de imagen"
						>
							×
						</button>
					</div>
				</div>
			)}
		</>
	);
}
