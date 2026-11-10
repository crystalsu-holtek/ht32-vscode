	.syntax unified
/*---------------------------------------------------------------------------------------------------------*/
/* Holtek Semiconductor Inc.                                                                               */
/*                                                                                                         */
/* Copyright (C) Holtek Semiconductor Inc.                                                                 */
/* All rights reserved.                                                                                    */
/*                                                                                                         */
/*-----------------------------------------------------------------------------------------------------------
  File Name        : image_info.s
  Version          : $Rev:: 408          $
  Date             : $Date:: 2025-06-06 #$
  Description      : Image information.
-----------------------------------------------------------------------------------------------------------*/

/* <<< Use Configuration Wizard in Context Menu >>>                                                        */

/* //   <o0> Version String Length <0-12:1> */
.equ VER_LEN, 6
.equ VER_STR0, 'V'   /* Put "Space" if not use */
.equ VER_STR1, '1'   /* Put "Space" if not use */
.equ VER_STR2, '.'   /* Put "Space" if not use */
.equ VER_STR3, '0'   /* Put "Space" if not use */
.equ VER_STR4, '.'   /* Put "Space" if not use */
.equ VER_STR5, '0'   /* Put "Space" if not use */
.equ VER_STR6, ' '   /* Put "Space" if not use */
.equ VER_STR7, ' '   /* Put "Space" if not use */
.equ VER_STR8, ' '   /* Put "Space" if not use */
.equ VER_STR9, ' '   /* Put "Space" if not use */
.equ VER_STR10, ' '   /* Put "Space" if not use */
.equ VER_STR11, ' '   /* Put "Space" if not use */

.equ HEADER_STR0, 'F'
.equ HEADER_STR1, 'O'

.equ INFO_0, ((HEADER_STR1 << 24) + (HEADER_STR0 << 16) + VER_LEN)
.equ INFO_1, ((VER_STR3 << 24)  + (VER_STR2 << 16)  + (VER_STR1 << 8) + VER_STR0)
.equ INFO_2, ((VER_STR7 << 24)  + (VER_STR6 << 16)  + (VER_STR5 << 8) + VER_STR4)
.equ INFO_3, ((VER_STR11 << 24) + (VER_STR10 << 16) + (VER_STR9 << 8) + VER_STR8)

                    /* !!! NOTICE !!! */
                    /* You should change the "_HT32FWID" setting in the file "startup_ht32fxxxxx_nn.s" */
                    /* if you use the "_Loader_IsAPFWIDVailed()" in the Loader ("loader.c"). */

.equ INFO_CK, (INFO_0 + INFO_1 + INFO_2 + INFO_3 + _HT32FWID)

	.long INFO_0                             /* ---, 04, 0x010, Header + Version String Length */
	.long INFO_1                             /* ---, 05, 0x014, Version String 0 ~ 3 */
	.long INFO_2                             /* ---, 06, 0x018, Version String 4 ~ 7 */
	.long INFO_3                             /* ---, 07, 0x01C, Version String 8 ~ 11 */
	.long _HT32FWID                          /* ---, 08, 0x020, Chip name */
	.long INFO_CK                            /* ---, 09, 0x024, Checksum */


