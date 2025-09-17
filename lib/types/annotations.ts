export type AnnotationStatus = "open" | "resolved" | "archived";
export type SelectorType = "page" | "css" | "range" | "manual";

export interface Selector {
  type: SelectorType;
  value: string;
}

export interface AnnotationBody {
  text?: string;
  anchor?: { x: number; y: number };
  [key: string]: unknown;
}

export interface Annotation {
  id: string;
  project_id: string;
  url: string;
  selector: Selector;
  body: AnnotationBody;
  status: AnnotationStatus;
  created_at: string;
  updated_at: string;
}

export interface AnnotationMessage {
  id: string;
  annotation_id: string;
  author_id: string | null;
  body: string;
  created_at: string;
  author_email?: string | null;
}
