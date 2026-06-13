import { ReactNode, useEffect, useRef } from "react";

type ModalProps = {
  open: boolean;
  /** Called when the user dismisses (Esc or backdrop click). Ignored when
   *  `dismissable` is false. */
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** When false, Esc and backdrop clicks are swallowed so the user has to make
   *  an explicit choice from the modal's own buttons. */
  dismissable?: boolean;
};

/**
 * App-wide modal built on the native <dialog> element. Driving it from `open`
 * keeps it declarative — callers flip a boolean and the dialog opens as a true
 * top-layer modal (focus trap, Esc handling, inert background) for free.
 */
export default function Modal({ open, onClose, title, children, dismissable = true }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    else if (!open && dlg.open) dlg.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        // Esc. Always preventDefault so the dialog can't close behind React's
        // back (which would desync `open`); route through onClose instead.
        e.preventDefault();
        if (dismissable) onClose();
      }}
      onClick={(e) => {
        // A click whose target is the <dialog> itself landed on the ::backdrop;
        // clicks inside .modal-body have an inner element as their target.
        if (dismissable && e.target === ref.current) onClose();
      }}
    >
      <div className="modal-body">
        {title && <h2 className="modal-title">{title}</h2>}
        {children}
      </div>
    </dialog>
  );
}
