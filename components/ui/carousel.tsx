"use client";

import * as React from "react";
import useEmblaCarousel from "embla-carousel-react";
import type { EmblaCarouselType, EmblaOptionsType } from "embla-carousel";
import { cn } from "@/lib/utils";

type CarouselContextProps = {
  carouselRef: (node: HTMLElement | null) => void;
  api: EmblaCarouselType | undefined;
  orientation: "horizontal" | "vertical";
};

const CarouselContext = React.createContext<CarouselContextProps | null>(null);

export function useCarousel() {
  const context = React.useContext(CarouselContext);
  if (!context) throw new Error("useCarousel must be used within <Carousel>");
  return context;
}

export interface CarouselProps extends React.HTMLAttributes<HTMLDivElement> {
  opts?: EmblaOptionsType;
  orientation?: "horizontal" | "vertical";
}

export function Carousel({ opts, orientation = "horizontal", className, children, ...props }: CarouselProps) {
  const [emblaRef, emblaApi] = useEmblaCarousel({ ...opts, axis: orientation === "horizontal" ? "x" : "y" });

  return (
    <CarouselContext.Provider value={{ carouselRef: emblaRef, api: emblaApi ?? undefined, orientation }}>
      <div className={cn("relative", className)} {...props}>
        {children}
      </div>
    </CarouselContext.Provider>
  );
}

export const CarouselContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { carouselRef, orientation } = useCarousel();
    return (
      <div ref={(node: HTMLElement | null) => carouselRef(node)} className="overflow-hidden">
        <div
          ref={ref}
          className={cn(
            "flex",
            orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col",
            className
          )}
          {...props}
        />
      </div>
    );
  }
);
CarouselContent.displayName = "CarouselContent";

export const CarouselItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { orientation } = useCarousel();
    return (
      <div
        ref={ref}
        className={cn(
          "min-w-0 shrink-0 grow-0", // slide
          orientation === "horizontal" ? "pl-4 basis-auto" : "pt-4 basis-auto",
          className
        )}
        {...props}
      />
    );
  }
);
CarouselItem.displayName = "CarouselItem";

export function CarouselPrevious({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { api, orientation } = useCarousel();
  return (
    <button
      type="button"
      aria-label="Previous"
      onClick={() => api?.scrollPrev()}
      className={cn(
        "absolute rounded-full border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow p-1",
        orientation === "horizontal" ? "left-2 top-1/2 -translate-y-1/2" : "top-2 left-1/2 -translate-x-1/2",
        className
      )}
      {...props}
    >
      ‹
    </button>
  );
}

export function CarouselNext({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { api, orientation } = useCarousel();
  return (
    <button
      type="button"
      aria-label="Next"
      onClick={() => api?.scrollNext()}
      className={cn(
        "absolute rounded-full border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 shadow p-1",
        orientation === "horizontal" ? "right-2 top-1/2 -translate-y-1/2" : "bottom-2 left-1/2 -translate-x-1/2",
        className
      )}
      {...props}
    >
      ›
    </button>
  );
}
