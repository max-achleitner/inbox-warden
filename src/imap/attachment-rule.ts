/** What the attachment rule needs to know about one leaf part, however the part was read. */
export interface PartShape {
  /** Content-Disposition type, lower case, if any. */
  disposition?: string;
  contentType?: string;
  hasContentId: boolean;
  /** The part carries a file name (Content-Disposition filename or Content-Type name). */
  hasName: boolean;
}

/**
 * The one rule for "this part is an attachment" (search_emails' hasAttachment and read_email):
 * disposition "attachment" always counts; otherwise a part with a file name counts — Apple Mail and
 * many mobile clients send files as "inline; filename=…" — except an image with a Content-ID,
 * which is shown inside the HTML (logos in signatures).
 */
export function countsAsAttachment(part: PartShape): boolean {
  if (part.disposition?.toLowerCase() === "attachment") return true;
  const embeddedImage = (part.contentType ?? "").toLowerCase().startsWith("image/") && part.hasContentId;
  return part.hasName && !embeddedImage;
}
