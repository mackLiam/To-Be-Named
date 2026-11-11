'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';

import { Spinner } from '../../Spinner';
import styles from '../admin.module.css';
import { deletePhoto, movePhoto, savePhotoAlt, setMainPhoto } from './photo-actions';
import { MAX_ALT_TEXT, UPLOAD_HEADER } from '@/lib/product-images';

export interface PhotoView {
  id: string;
  alt_text: string;
  is_main: boolean;
  /** Public URL, or null when it cannot be resolved (fake mode). */
  src: string | null;
}

/**
 * Upload and manage a product's photos. A client component for the upload
 * (raw body to the route handler, with a loading state) and the two-step
 * delete; every check runs server-side in the route handler and the photo
 * server actions.
 */
export function PhotoManager({ productId, photos }: { productId: string; photos: PhotoView[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [alt, setAlt] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setUploadError('Choose a photo to upload.');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const response = await fetch(
        `/admin/api/products/${productId}/images?alt=${encodeURIComponent(alt)}`,
        {
          method: 'POST',
          body: file,
          headers: {
            'content-type': file.type || 'application/octet-stream',
            [UPLOAD_HEADER]: '1',
          },
        },
      );
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setUploadError(body.error ?? `Upload failed (error ${response.status}). Try again.`);
        return;
      }
      setAlt('');
      if (fileRef.current) {
        fileRef.current.value = '';
      }
      router.refresh();
    } catch {
      setUploadError('Upload failed: the connection dropped. Try again.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div id="photos">
      {photos.length === 0 ? (
        <p className={styles.actionNote}>
          No photos yet. Upload one below; the first photo becomes the main image the shop shows.
        </p>
      ) : (
        <ol className={styles.photoList} aria-label="Product photos, in shop order">
          {photos.map((photo, index) => (
            <li key={photo.id} className={styles.photoItem}>
              {photo.src ? (
                // eslint-disable-next-line @next/next/no-img-element -- public bucket URL, no loader configured
                <img src={photo.src} alt={photo.alt_text} className={styles.photoThumb} />
              ) : (
                <span className={styles.photoPlaceholder}>No preview</span>
              )}
              <div className={styles.photoBody}>
                <div className={styles.photoMeta}>
                  Photo {index + 1} of {photos.length}
                  {photo.is_main ? ', main image' : ''}
                </div>
                <form action={savePhotoAlt} className={styles.altRow}>
                  <input type="hidden" name="product_id" value={productId} />
                  <input type="hidden" name="image_id" value={photo.id} />
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Alt text for photo {index + 1}</span>
                    <input
                      className={styles.input}
                      name="alt_text"
                      defaultValue={photo.alt_text}
                      required
                      maxLength={MAX_ALT_TEXT}
                    />
                  </label>
                  <button type="submit" className={styles.secondaryBtn}>
                    Save alt text
                  </button>
                </form>
                <div className={styles.photoActions}>
                  {photo.is_main ? null : (
                    <form action={setMainPhoto} className={styles.inlineForm}>
                      <input type="hidden" name="product_id" value={productId} />
                      <input type="hidden" name="image_id" value={photo.id} />
                      <button type="submit" className={styles.secondaryBtn}>
                        Make main
                      </button>
                    </form>
                  )}
                  {(['up', 'down'] as const).map((direction) => {
                    const atEdge = direction === 'up' ? index === 0 : index === photos.length - 1;
                    return (
                      <form key={direction} action={movePhoto} className={styles.inlineForm}>
                        <input type="hidden" name="product_id" value={productId} />
                        <input type="hidden" name="image_id" value={photo.id} />
                        <input type="hidden" name="direction" value={direction} />
                        <button
                          type="submit"
                          className={styles.secondaryBtn}
                          disabled={atEdge}
                          aria-label={`Move photo ${index + 1} ${direction}`}
                        >
                          {direction === 'up' ? 'Move up' : 'Move down'}
                        </button>
                      </form>
                    );
                  })}
                  {confirmDelete === photo.id ? (
                    <form action={deletePhoto} className={styles.inlineForm}>
                      <input type="hidden" name="product_id" value={productId} />
                      <input type="hidden" name="image_id" value={photo.id} />
                      <button type="submit" className={styles.secondaryBtn}>
                        Confirm delete photo {index + 1}
                      </button>{' '}
                      <button
                        type="button"
                        className={styles.secondaryBtn}
                        onClick={() => setConfirmDelete(null)}
                      >
                        Keep
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => setConfirmDelete(photo.id)}
                      aria-label={`Delete photo ${index + 1}`}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={upload} className={styles.form} aria-busy={uploading}>
        {uploadError ? (
          <p className={styles.formError} role="alert">
            {uploadError}
          </p>
        ) : null}
        <div className={styles.formRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Photo file</span>
            <input
              ref={fileRef}
              className={styles.input}
              type="file"
              name="file"
              accept="image/jpeg,image/png,image/webp"
              required
              aria-describedby="photo-hint"
            />
            <span className={styles.fieldHint} id="photo-hint">
              JPEG, PNG or WebP, at most 5 MB and 6000 px per side.
            </span>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Alt text</span>
            <input
              className={styles.input}
              name="alt"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              required
              maxLength={MAX_ALT_TEXT}
              placeholder="Shin guard, front view"
            />
            <span className={styles.fieldHint}>Describe what the photo shows. Required.</span>
          </label>
        </div>
        <div className={styles.actionBar}>
          <button
            type="submit"
            className={styles.primaryBtn}
            disabled={uploading}
            aria-busy={uploading}
          >
            {uploading ? (
              <>
                <Spinner />
                Uploading
              </>
            ) : (
              'Upload photo'
            )}
          </button>
          {uploading ? (
            <span className={styles.actionNote} role="status">
              Uploading, please wait.
            </span>
          ) : null}
        </div>
      </form>
    </div>
  );
}
