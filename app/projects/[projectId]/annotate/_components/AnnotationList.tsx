"use client";
import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import NextImage from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";

const STATUS_OPTIONS = [
	{ value: "open", label: "Open" },
	{ value: "resolved", label: "Resolved" },
	{ value: "archived", label: "Archived" },
];

type Ann = {
	id?: string;
	url?: string;
	project_id?: string;
	body?: {
		text?: string;
		display_name?: string;
		time_of_day?: string;
		author_avatar_url?: string;
	} | null;
	status?: string | null;
	created_by?: string;
	assigned_to?: string | null;
};

export default function AnnotationList({
	items,
	activeId,
	onSelect,
	currentPageUrl,
	onNavigateToUrl,
	refresh,
}: {
	items?: Ann[] | null;
	activeId: string | null;
	onSelect?: (id: string) => void;
	currentPageUrl: string;
	onNavigateToUrl?: (url: string) => void;
	refresh?: () => void;
}) {
	const safeItems = useMemo(() => (Array.isArray(items) ? items : []), [items]);

	const [deleting, setDeleting] = useState<string | null>(null);
	const [updating, setUpdating] = useState<string | null>(null);
	const [avatarByUserId, setAvatarByUserId] = useState<Record<string, string>>({});
	const [membersByProject, setMembersByProject] = useState<
		Record<string, Array<{ id: string; label: string }>>
	>({});
	const [roleByProject, setRoleByProject] = useState<
		Record<string, "viewer" | "editor" | "owner" | null>
	>({});
	const fetchingRef = useRef(false);

	// Determine which user IDs are missing avatars
	const missingUserIds = useMemo(() => {
		const ids = new Set<string>();
		for (const a of safeItems) {
			const hasAvatar = Boolean(a.body?.author_avatar_url);
			const uid = a.created_by;
			if (!hasAvatar && typeof uid === "string" && !avatarByUserId[uid]) {
				ids.add(uid);
			}
		}
		return Array.from(ids);
	}, [safeItems, avatarByUserId]);

	// Backfill avatars
	useEffect(() => {
		if (fetchingRef.current) return;
		if (!missingUserIds.length) return;
		fetchingRef.current = true;
		(async () => {
			try {
				const res = await fetch("/api/users/info", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ids: missingUserIds }),
				});
				const out = (await res.json()) as {
					users?: Array<{ id: string; avatar_url?: string | null }>;
				};
				const next: Record<string, string> = {};
				for (const u of out.users ?? []) {
					if (u.id && u.avatar_url) next[u.id] = u.avatar_url;
				}
				if (Object.keys(next).length) {
					setAvatarByUserId((prev) => ({ ...prev, ...next }));
				}
			} catch {
				// ignore
			} finally {
				fetchingRef.current = false;
			}
		})();
	}, [missingUserIds]);

	// Fetch members and role per project for visible annotations
	useEffect(() => {
		(async () => {
			const projIds = Array.from(
				new Set(safeItems.map((a) => a.project_id).filter(Boolean))
			) as string[];
			for (const pid of projIds) {
				if (membersByProject[pid] && roleByProject[pid] !== undefined) continue;
				try {
					const res = await fetch(`/api/projects/${pid}/members`, {
						cache: "no-store",
					});
					const out = (await res.json()) as {
						me_role?: "viewer" | "editor" | "owner" | null;
						members?: Array<{
							user_id: string;
							email?: string | null;
							first_name?: string | null;
							last_name?: string | null;
							username?: string | null;
						}>;
					};
					const mapped = (out.members ?? []).map((m) => {
						const name =
							m.username ||
							[m.first_name, m.last_name].filter(Boolean).join(" ") ||
							m.email ||
							m.user_id;
						return { id: m.user_id, label: name };
					});
					setMembersByProject((prev) => ({ ...prev, [pid]: mapped }));
					setRoleByProject((prev) => ({ ...prev, [pid]: out.me_role ?? null }));
				} catch {
					// ignore
				}
			}
		})();
	}, [safeItems, membersByProject, roleByProject]);

	async function handleDelete(id?: string) {
		if (!id) return;
		setDeleting(id);
		await fetch(`/api/annotations/${id}`, { method: "DELETE" });
		setDeleting(null);
		refresh?.();
	}

	async function handleStatusChange(id: string, status: string) {
		setUpdating(id);
		let ok = false;
		try {
			const res = await fetch(`/api/annotations/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status }),
			});
			ok = res.ok;
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				console.warn("Status update failed", data?.error || res.statusText);
				alert("You don’t have permission to change status.");
			}
		} finally {
			setUpdating(null);
			if (ok) refresh?.();
		}
	}

	async function handleAssignChange(id: string, assigned_to: string | "") {
		setUpdating(id);
		let ok = false;
		try {
			const res = await fetch(`/api/annotations/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ assigned_to: assigned_to || null }),
			});
			ok = res.ok;
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				console.warn("Assign update failed", data?.error || res.statusText);
				alert("You don’t have permission to assign.");
			}
		} finally {
			setUpdating(null);
			if (ok) refresh?.();
		}
	}

	// Normalize URLs for comparison (remove hash, trailing slash, etc.)
	function normalizeUrl(url?: string) {
		if (!url) return "";
		try {
			const u = new URL(url, "http://dummy");
			u.hash = "";
			return u.toString().replace("http://dummy", "");
		} catch {
			return url.split("#")[0];
		}
	}

	const normalizedCurrent = normalizeUrl(currentPageUrl);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const toggleExpanded = (id: string) =>
		setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
	const excerpt = (text?: string, max = 180) => {
		if (!text) return "(no text)";
		if (text.length <= max) return text;
		return text.slice(0, max).trimEnd() + "…";
	};

	return (
		<div className="overflow-auto h-full divide-y">
			{safeItems.map((a, idx) => {
				const isCurrent =
					normalizeUrl(a.url) === normalizedCurrent ||
					decodeURIComponent(normalizeUrl(a.url)) === normalizedCurrent;

				const displayName = a.body?.display_name || "Unknown";
				const avatarFromBody = a.body?.author_avatar_url as string | undefined;
				const uid = a.created_by as string | undefined;
				const avatarFromCache = uid ? avatarByUserId[uid] : undefined;
				const avatarUrl =
					avatarFromBody ||
					avatarFromCache ||
					`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(
						displayName
					)}`;

				const role = a.project_id ? roleByProject[a.project_id] : null;
				const canEdit = role === "editor" || role === "owner";
				return (
					<div
						key={a.id ?? idx}
						className={cn(
							"px-3 py-2 flex items-center gap-2 hover:bg-muted/50",
							a.id && activeId === a.id && "bg-muted"
						)}
					>
						{avatarUrl ? (
							<NextImage
								src={avatarUrl}
								alt={displayName}
								width={24}
								height={24}
								unoptimized
								className="h-6 w-6 rounded-full border object-cover"
							/>
						) : (
							<Skeleton className="h-6 w-6 rounded-full" />
						)}
						<div className="flex-1">
							{a.id && expanded[a.id] ? (
								<div
									className="whitespace-pre-wrap break-words text-sm leading-5"
									onClick={() => a.id && onSelect?.(a.id)}
								>
									<ReactMarkdown
										remarkPlugins={[remarkGfm]}
										rehypePlugins={[rehypeSanitize]}
									>
										{a.body?.text ?? "(no text)"}
									</ReactMarkdown>
								</div>
							) : (
								<div
									className="text-sm whitespace-pre-wrap break-words"
									onClick={() => a.id && onSelect?.(a.id)}
								>
									<ReactMarkdown
										remarkPlugins={[remarkGfm]}
										rehypePlugins={[rehypeSanitize]}
									>
										{excerpt(a.body?.text, 200)}
									</ReactMarkdown>
								</div>
							)}
							{a.id && (a.body?.text?.length ?? 0) > 200 && (
								<button
									type="button"
									className="mt-1 text-xs text-blue-600 underline"
									onClick={(e) => {
										e.stopPropagation();
										toggleExpanded(a.id!);
									}}
								>
									{expanded[a.id] ? "Show less" : "Show more"}
								</button>
							)}
							<div className="mt-1" onClick={() => a.id && onSelect?.(a.id)}>
								<div className="text-xs text-muted-foreground">
									{displayName}
									{a.body?.time_of_day ? ` • ${a.body.time_of_day}` : ""}
								</div>
								<div className="text-xs text-muted-foreground">
									<select
										className="border rounded px-1 py-0.5 text-xs"
										value={a.status ?? "open"}
										disabled={updating === a.id || !canEdit}
										onChange={(e) => a.id && handleStatusChange(a.id, e.target.value)}
										style={{ minWidth: 110 }}
									>
										{STATUS_OPTIONS.map((opt) => (
											<option key={opt.value} value={opt.value}>
												{opt.label}
											</option>
										))}
									</select>
									<span className="mx-2">•</span>
									<select
										className="border rounded px-1 py-0.5 text-xs"
										value={a.assigned_to ?? ""}
										disabled={updating === a.id || !canEdit}
										onChange={(e) => a.id && handleAssignChange(a.id, e.target.value)}
										style={{ minWidth: 140 }}
									>
										<option value="">Unassigned</option>
										{(a.project_id && membersByProject[a.project_id]
											? membersByProject[a.project_id]
											: []
										).map((m) => (
											<option key={m.id} value={m.id}>
												{m.label}
											</option>
										))}
									</select>
									{updating === a.id && (
										<span className="ml-2 text-xs text-muted-foreground">
											Saving…
										</span>
									)}
								</div>
							</div>
							{a.url && (
								<div className="text-xs mt-1">
									<button
										type="button"
										className="text-blue-600 underline break-all"
										style={{
											background: "none",
											border: "none",
											padding: 0,
											cursor: "pointer",
										}}
										onClick={(e) => {
											e.stopPropagation();
											onNavigateToUrl?.(a.url!);
										}}
									>
										{a.url}
									</button>
									{isCurrent && (
										<span className="ml-2 px-2 py-0.5 rounded bg-green-100 text-green-800 text-xs">
											Current page
										</span>
									)}
								</div>
							)}
						</div>
						{a.id && (
							<Button
								variant="destructive"
								size="sm"
								disabled={deleting === a.id}
								onClick={() => handleDelete(a.id)}
							>
								{deleting === a.id ? "Deleting..." : "Delete"}
							</Button>
						)}
					</div>
				);
			})}
			{safeItems.length === 0 && (
				<div className="p-4 text-sm text-muted-foreground">No annotations yet.</div>
			)}
		</div>
	);
}
