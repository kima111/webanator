"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function NewProjectChooser({ action }: { action: (fd: FormData) => Promise<void> }) {
  const [openWebsite, setOpenWebsite] = useState(false);
  const [openImage, setOpenImage] = useState(false);

  return (
    <div className="flex flex-col items-center gap-6 w-full">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle className="text-base text-center">Create a New Project</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center gap-6">
            <Button onClick={() => setOpenWebsite(true)}>Website</Button>
            <Button variant="secondary" onClick={() => setOpenImage(true)}>Image</Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={openWebsite} onOpenChange={setOpenWebsite}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Website Project</DialogTitle>
          </DialogHeader>
          <form
            action={action}
            className="grid gap-4"
            onSubmit={() => setOpenWebsite(false)}
          >
            <input type="hidden" name="type" value="website" />
            <div className="grid gap-2">
              <label className="text-xs font-medium">Project name (optional)</label>
              <Input name="project_name" placeholder="Marketing Site" />
            </div>
            <div className="grid gap-2">
              <label className="text-xs font-medium">Website URL</label>
              <Input name="url" type="url" required placeholder="https://example.com" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpenWebsite(false)}>Cancel</Button>
              <Button type="submit"><Plus className="w-4 h-4 mr-1" />Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={openImage} onOpenChange={setOpenImage}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Image Project</DialogTitle>
          </DialogHeader>
          <form
            action={action}
            className="grid gap-4"
            /* React Server Actions automatically set method=POST and enctype=multipart/form-data when a file input is present */
            onSubmit={() => setOpenImage(false)}
          >
            <input type="hidden" name="type" value="image" />
            <div className="grid gap-2">
              <label className="text-xs font-medium">Project name (optional)</label>
              <Input name="project_name" placeholder="Homepage Audit" />
            </div>
            <div className="grid gap-2">
              <label className="text-xs font-medium">Upload image</label>
              <Input
                name="image_file"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                required
              />
              <p className="text-[11px] text-muted-foreground">PNG, JPG, WEBP, GIF, SVG</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpenImage(false)}>Cancel</Button>
              <Button type="submit"><Plus className="w-4 h-4 mr-1" />Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}