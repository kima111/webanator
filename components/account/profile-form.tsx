"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import NextImage from "next/image";

export default function ProfileForm({
  email,
  username,
  firstName: initialFirst,
  lastName: initialLast,
  avatarUrl: initialAvatarUrl,
}: {
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
}) {
  const [firstName, setFirstName] = useState(initialFirst);
  const [lastName, setLastName] = useState(initialLast);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const nameSeed = [initialFirst, initialLast].filter(Boolean).join(" ").trim() || email || "User";
  const [avatarUrl, setAvatarUrl] = useState<string>(
    initialAvatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(nameSeed)}`
  );
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [imgNatural, setImgNatural] = useState<{ w: number; h: number } | null>(null);
  const PREVIEW_SIZE = 320;
  const CANVAS_SIZE = 512;
  const [scale, setScale] = useState(1.0);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; startOffX: number; startOffY: number } | null>(null);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setErr(null);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({
        data: { first_name: firstName, last_name: lastName },
      });
      if (error) throw error;
      setMsg("Saved");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function onPickFile() {
    fileRef.current?.click();
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    setMsg(null);
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (result) {
        setCropSrc(result);
        setScale(1);
        setOffset({ x: 0, y: 0 });
        setCropOpen(true);
      }
    };
    reader.readAsDataURL(file);
  }

  useEffect(() => {
    if (!cropSrc) return;
    const img = new Image();
    img.onload = () => {
      setImgEl(img);
      setImgNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = cropSrc;
    return () => {
      setImgEl(null);
      setImgNatural(null);
    };
  }, [cropSrc]);

  function clampOffset(nx: number, ny: number, s: number): { x: number; y: number } {
    const w = imgNatural?.w ?? 0;
    const h = imgNatural?.h ?? 0;
    const dispW = w * s;
    const dispH = h * s;
    const limitX = Math.abs(dispW - PREVIEW_SIZE) / 2;
    const limitY = Math.abs(dispH - PREVIEW_SIZE) / 2;
    return { x: Math.min(Math.max(nx, -limitX), limitX), y: Math.min(Math.max(ny, -limitY), limitY) };
  }

  function onStartDrag(e: React.PointerEvent<HTMLDivElement>) {
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffX: offset.x, startOffY: offset.y };
  }
  function onDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const next = clampOffset(dragRef.current.startOffX + dx, dragRef.current.startOffY + dy, scale);
    setOffset(next);
  }
  function onEndDrag(e: React.PointerEvent<HTMLDivElement>) {
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    dragRef.current = null;
  }

  function onScaleChange(v: number) {
    const clamped = clampOffset(offset.x, offset.y, v);
    setScale(v);
    setOffset(clamped);
  }

  function fitContain() {
    if (!imgNatural) return;
    const s = Math.min(PREVIEW_SIZE / imgNatural.w, PREVIEW_SIZE / imgNatural.h);
    const clamped = Math.max(0.02, Math.min(6, s));
    setScale(clamped);
    setOffset({ x: 0, y: 0 });
  }

  function fitCover() {
    if (!imgNatural) return;
    const s = Math.max(PREVIEW_SIZE / imgNatural.w, PREVIEW_SIZE / imgNatural.h);
    const clamped = Math.max(0.02, Math.min(6, s));
    setScale(clamped);
    setOffset({ x: 0, y: 0 });
  }

  function centerImage() {
    setOffset({ x: 0, y: 0 });
  }

  async function saveCroppedImage() {
    if (!imgEl || !imgNatural) return;
    try {
      setUploading(true);
      const canvas = document.createElement("canvas");
      canvas.width = CANVAS_SIZE;
      canvas.height = CANVAS_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas not supported");

      ctx.save();
      ctx.beginPath();
      ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      const C = PREVIEW_SIZE;
      const s = scale;
      const w = imgNatural.w;
      const h = imgNatural.h;
      const dispW = w * s;
      const dispH = h * s;
      const TLx = C / 2 - dispW / 2 + offset.x;
      const TLy = C / 2 - dispH / 2 + offset.y;
      const sx = (0 - TLx) / s;
      const sy = (0 - TLy) / s;
      const sSize = C / s;

      ctx.drawImage(imgEl, sx, sy, sSize, sSize, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
      ctx.restore();

      const blob: Blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to export image"))), "image/png", 0.92)
      );

      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error("Not signed in");

      const ext = "png";
      const path = `${user.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("avatars").upload(path, blob, {
        upsert: true,
        cacheControl: "3600",
        contentType: "image/png",
      });
      if (upErr) {
        if (String(upErr?.message || "").toLowerCase().includes("bucket not found")) {
          await fetch("/api/admin/init-avatars", { method: "POST" });
          const retry = await supabase.storage.from("avatars").upload(path, blob, {
            upsert: true,
            cacheControl: "3600",
            contentType: "image/png",
          });
          if (retry.error) throw retry.error;
        } else {
          throw upErr;
        }
      }

      const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
      const url = pub.publicUrl;
      const { error: updErr } = await supabase.auth.updateUser({ data: { avatar_url: url } });
      if (updErr) throw updErr;

      setAvatarUrl(url);
      setMsg("Profile photo updated");
      setCropOpen(false);
      setCropSrc(null);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <form className="grid gap-6" onSubmit={onSave}>
      {/* Avatar */}
      <div className="flex items-center gap-4">
        <NextImage
          src={avatarUrl}
          alt="Profile photo"
          width={64}
          height={64}
          unoptimized
          className="h-16 w-16 rounded-full border object-cover bg-muted"
        />
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onFileChange}
          />
          <Button type="button" variant="outline" size="sm" onClick={onPickFile} disabled={uploading}>
            {uploading ? "Uploading..." : "Change photo"}
          </Button>
        </div>
      </div>

      {/* Crop Dialog */}
      <Dialog open={cropOpen} onOpenChange={setCropOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Position your photo</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div
              className="mx-auto rounded-full overflow-hidden border relative"
              style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE, touchAction: "none" }}
              onPointerDown={onStartDrag}
              onPointerMove={onDrag}
              onPointerUp={onEndDrag}
              onPointerCancel={onEndDrag}
            >
              {cropSrc ? (
                <NextImage
                  src={cropSrc}
                  alt="Crop preview"
                  draggable={false}
                  unoptimized
                  fill
                  sizes={`${PREVIEW_SIZE}px`}
                  className="absolute top-1/2 left-1/2 select-none"
                  style={{
                    transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                    transformOrigin: "center center",
                    willChange: "transform",
                    objectFit: "contain",
                  }}
                />
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <Label className="w-16">Zoom</Label>
              <input
                type="range"
                min={0.02}
                max={6}
                step={0.01}
                value={scale}
                onChange={(e) => onScaleChange(parseFloat(e.target.value))}
                className="flex-1"
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={fitContain} disabled={uploading || !imgNatural}>
                Fit
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={fitCover} disabled={uploading || !imgNatural}>
                Fill
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={centerImage} disabled={uploading}>
                Center
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCropOpen(false)} disabled={uploading}>
              Cancel
            </Button>
            <Button type="button" onClick={saveCroppedImage} disabled={uploading || !imgEl}>
              {uploading ? "Saving..." : "Save crop"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Read-only fields */}
      <div className="grid gap-2 max-w-xl">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" value={email} disabled className="opacity-75" />
      </div>
      <div className="grid gap-2 max-w-xl">
        <Label htmlFor="username">Username</Label>
        <Input id="username" type="text" value={username} disabled className="opacity-75" />
      </div>

      {/* Editable fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-3xl">
        <div className="grid gap-2">
          <Label htmlFor="first-name">First name</Label>
          <Input
            id="first-name"
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="last-name">Last name</Label>
          <Input
            id="last-name"
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
          />
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving..." : "Save changes"}
        </Button>
        {msg && <span className="text-xs text-emerald-600">{msg}</span>}
        {err && <span className="text-xs text-red-600">{err}</span>}
      </div>
    </form>
  );
}