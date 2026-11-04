import { PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";

/** Preserve all ordinary PDF.js links while making its shared embedded-content hook explicit. */
export class AttachmentLinkService extends PDFLinkService {
  private readonly getContent: (id: string) => Promise<Uint8Array | null>;

  constructor(
    options: ConstructorParameters<typeof PDFLinkService>[0],
    getContent: (id: string) => Promise<Uint8Array | null>,
  ) {
    super(options);
    this.getContent = getContent;
  }

  override async getAttachmentContent(id: string): Promise<Uint8Array | null> {
    try { return await this.getContent(id); }
    catch { return null; }
  }
}
