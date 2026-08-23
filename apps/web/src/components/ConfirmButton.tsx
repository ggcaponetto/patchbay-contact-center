/**
 * A button that asks "Are you sure?" in a dialog before running its action. Used for
 * the destructive settings actions (delete a queue, an API key, an uploaded sound).
 */
import {
  Button,
  type ButtonProps,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
} from '@mui/material';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * See the module comment. `icon` renders an `IconButton` with `children` as its glyph;
 * `confirmLabel` defaults to the translated "Delete".
 */
export function ConfirmButton({
  title,
  message,
  confirmLabel,
  onConfirm,
  icon = false,
  children,
  ...props
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  icon?: boolean;
  children: ReactNode;
} & Omit<ButtonProps, 'onClick' | 'title'>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      {icon ? (
        <IconButton
          size={props.size}
          color={props.color}
          disabled={props.disabled}
          aria-label={props['aria-label']}
          onClick={() => setOpen(true)}
        >
          {children}
        </IconButton>
      ) : (
        <Button {...props} onClick={() => setOpen(true)}>
          {children}
        </Button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <DialogContentText>{message}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel ?? t('common.delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
