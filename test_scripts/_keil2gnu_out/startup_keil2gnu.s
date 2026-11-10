	.syntax unified
/*---------------------------------------------------------------------------------------------------------*/
/* Holtek Semiconductor Inc.                                                                               */
/*                                                                                                         */
/* Copyright (C) Holtek Semiconductor Inc.                                                                 */
/* All rights reserved.                                                                                    */
/*                                                                                                         */
/*-----------------------------------------------------------------------------------------------------------
  File Name        : startup_ht32f5xxxx_01.s
  Version          : $Rev:: 8504         $
  Date             : $Date:: 2025-04-01 #$
  Description      : Startup code.
  Notice           : This file is different with the template of Firmware Library. !! MUST CHECK AFTER SYNC !!
-----------------------------------------------------------------------------------------------------------*/

@ Supported Device
@ ========================================
@ HT32F52220, HT32F52230
@ HT32F52231, HT32F52241
@ HT32F52331, HT32F52341
@ HT32F52342, HT32F52352
@ HT32F52243, HT32F52253
@ HT32F0008
@ HT32F52344, HT32F52354
@ HT32F0006
@ HT32F61352
@ HT50F32003
@ HT50F3200U
@ HT50F32016
@ HT32F62030, HT32F62040, HT32F62050
@ HT32F62132
@ HT32F62140
@ HT32F67741
@ HT32F67232
@ HT32F67233
@ HT32F59045
@ MXTX52231
@ MXTX52352
@ HT32F62143
@ HT50F32023
@ HT50F32022

/* <<< Use Configuration Wizard in Context Menu >>>                                                        */

@ // <o>  HT32 Device
@ // <i> Select HT32 Device for the assembly setting. 
@ // <i> Notice that the project's Asm Define has the higher priority.
@ //      <0=> By Project Asm Define
@ //      <1=> HT32F52220/30
@ //      <2=> HT32F52231/41
@ //      <3=> HT32F52331/41
@ //      <4=> HT32F52342/52
@ //      <5=> HT32F52243/53
@ //      <6=> HT32F0008
@ //      <9=> HT32F52344/54
@ //      <10=> HT32F0006
@ //      <10=> HT32F61352
@ //      <4=> HT50F32003
@ //      <2=> HT50F3200U
@ //      <2=> HT50F32016
@ //      <2=> HT32F67741
@ //      <1=> HT32F67232
@ //      <1=> HT32F67233
@ //      <1=> HT32F62030
@ //      <2=> HT32F62040
@ //      <5=> HT32F62050
@ //      <2=> HT32F62132
@ //      <2=> HT32F62140
@ //      <2=> HT32F59045
@ //      <2=> MXTX52231
@ //      <4=> MXTX52352
@ //      <2=> HT32F62143
@ //      <2=> HT50F32023
@ //      <2=> HT50F32022
.equ USE_HT32_CHIP_SET, 0

.equ _HT32FWID, 0xFFFFFFFF
@ _HT32FWID           EQU     0x00052220
@ _HT32FWID           EQU     0x00052230
@ _HT32FWID           EQU     0x00052231
@ _HT32FWID           EQU     0x00052241
@ _HT32FWID           EQU     0x00052331
@ _HT32FWID           EQU     0x00052341
@ _HT32FWID           EQU     0x00052342
@ _HT32FWID           EQU     0x00052352
@ _HT32FWID           EQU     0x00052243
@ _HT32FWID           EQU     0x00052253
@ _HT32FWID           EQU     0x00000008
@ _HT32FWID           EQU     0x00052344
@ _HT32FWID           EQU     0x00052354
@ _HT32FWID           EQU     0x00000006
@ _HT32FWID           EQU     0x00061352
@ _HT32FWID           EQU     0x00032003
@ _HT32FWID           EQU     0x0003200F
@ _HT32FWID           EQU     0x00032016
@ _HT32FWID           EQU     0x00062030
@ _HT32FWID           EQU     0x00062040
@ _HT32FWID           EQU     0x00062050
@ _HT32FWID           EQU     0x00062132
@ _HT32FWID           EQU     0x00062140
@ _HT32FWID           EQU     0x00067741
@ _HT32FWID           EQU     0x00067232
@ _HT32FWID           EQU     0x00067233
@ _HT32FWID           EQU     0x00059045
@ _HT32FWID           EQU     0x00062143
@ _HT32FWID           EQU     0x00032023
@ _HT32FWID           EQU     0x00032022

.equ HT32F52220_30, 1
.equ HT32F52231_41, 2
.equ HT32F52331_41, 3
.equ HT32F52342_52, 4
.equ HT32F52243_53, 5
.equ HT32F0008, 6
.equ HT32F52344_54, 9
.equ HT32F0006, 10
.equ HT32F61352, 10
.equ HT50F32003, 4
.equ HT50F3200U, 2
.equ HT50F32016, 2
.equ HT32F62030, 1
.equ HT32F62040, 2
.equ HT32F62050, 5
.equ HT32F62132, 2
.equ HT32F62140, 2
.equ HT32F67741, 2
.equ HT32F67232, 1
.equ HT32F67233, 1
.equ HT32F59045, 2
.equ MXTX52231, 2
.equ MXTX52352, 4
.equ HT32F62143, 2
.equ HT50F32023, 2
.equ HT50F32022, 2

.if USE_HT32_CHIP_SET == 0
  @ Use project's Asm Define setting (default)
.else
#ifdef USE_HT32_CHIP
  @ Use project's Asm Define setting (higher priority than the "USE_HT32_CHIP_SET")
#else
  @ Use "USE_HT32_CHIP_SET" in the "startup_ht32xxxxx_xx.s" file
.equ USE_HT32_CHIP, USE_HT32_CHIP_SET
#endif
.endif

@ Amount of memory (in bytes) allocated for Stack and Heap
@ Tailor those values to your application needs

@ //   <o> Stack Location
@ //       <0=> After the RW/ZI/Heap (Default)
@ //       <1=> On the top of the SRAM (The end of the SRAM)
.equ USE_STACK_ON_TOP, 0

@ //   <o> Stack Size (in Bytes, must 8 byte aligned) <0-16384:8>
@ //       <i> Only meanful when the Stack Location = "After the RW/ZI/Heap" (USE_STACK_ON_TOP = 0).
.equ Stack_Size, 1024


/* start address for the initialization values of the .data section. defined in linker script */
	.word  _sidata
/* start address for the .data section. defined in linker script */
	.word  _sdata
/* end address for the .data section. defined in linker script */
	.word  _edata
/* start address for the .bss section. defined in linker script */
	.word  _sbss
/* end address for the .bss section. defined in linker script */
	.word  _ebss

	.section ".stack","aw",%nobits
	.align  3
	.globl  __StackTop
	.globl  __StackLimit
	.globl  __HT_check_sp
__HT_check_sp:
__StackLimit:
	.if     Stack_Size
	.space  Stack_Size
	.endif
	.size __StackLimit, . - __StackLimit
__StackTop:
	.size __StackTop, . - __StackTop
.if (USE_STACK_ON_TOP  ==  1)
.equ __StackTop, 0x20000000 + USE_LIBCFG_RAM_SIZE
.else
.endif

@ //   <o>  Heap Size (in Bytes) <0-16384:8>
.equ Heap_Size, 0

	.section ".heap","aw",%nobits
	.align  3
	.globl  __HeapBase
	.globl  _end
	.globl  __HeapLimit
	.globl  __HT_check_heap
__HT_check_heap:
__HeapBase:
_end:
	.if     Heap_Size
	.space  Heap_Size
	.endif
	.size __HeapBase, . - __HeapBase
__HeapLimit:
	.size __HeapLimit, . - __HeapLimit

	.balign 8
	.thumb

@ *******************************************************************************
@ Fill-up the Vector Table entries with the exceptions ISR address
@ *******************************************************************************
	.section .isr_vector,"a",%progbits
	.global __interrupt_vector_cortex_m
.equ _RESERVED, 0xFFFFFFFF
	.type  __interrupt_vector_cortex_m, %object
__interrupt_vector_cortex_m:
	.long __StackTop
	.long Reset_Handler
	.long NMI_Handler
	.long HardFault_Handler
	.include "image_info_gcc.s"
                    @ DCD  _RESERVED                          ; ---, 04, 0x010, Reserved
                    @ DCD  _RESERVED                          ; ---, 05, 0x014, Reserved
                    @ DCD  _RESERVED                          ; ---, 06, 0x018, Reserved
                    @ DCD  _RESERVED                          ; ---, 07, 0x01C, Reserved
                    @ DCD  _HT32FWID                          ; ---, 08, 0x020, Reserved
                    @ DCD  _RESERVED                          ; ---, 09, 0x024, Reserved
	.long _RESERVED
	.long SVC_Handler
	.long _RESERVED
	.long _RESERVED
	.long PendSV_Handler
	.long SysTick_Handler

                    @ External Interrupt Handler
	.long LVD_BOD_IRQHandler
.if (USE_HT32_CHIP == HT32F52220_30)
	.long _RESERVED
.else
	.long RTC_IRQHandler
.endif
	.long FLASH_IRQHandler
	.long EVWUP_IRQHandler
	.long EXTI0_1_IRQHandler
	.long EXTI2_3_IRQHandler
	.long EXTI4_15_IRQHandler
.if (USE_HT32_CHIP == HT32F52342_52) || (USE_HT32_CHIP == HT32F52344_54)
	.long COMP_IRQHandler
.else
	.long _RESERVED
.endif
.if (USE_HT32_CHIP == HT32F0008)
	.long _RESERVED
.else
	.long ADC_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F52243_53)
	.long I2C2_IRQHandler
.else
	.long _RESERVED
.endif
.if (USE_HT32_CHIP == HT32F52220_30) || (USE_HT32_CHIP == HT32F0008) || (USE_HT32_CHIP == HT32F0006)
	.long _RESERVED
.else
	.long MCTM0_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F52342_52)
	.long GPTM1_IRQHandler
.else
	.long _RESERVED
.endif
	.long GPTM0_IRQHandler
.if (USE_HT32_CHIP == HT32F0008)
	.long _RESERVED
	.long _RESERVED
.else
	.long SCTM0_IRQHandler
	.long SCTM1_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F52231_41) || (USE_HT32_CHIP == HT32F52331_41) || (USE_HT32_CHIP == HT32F52243_53) || (USE_HT32_CHIP == HT32F0006)
	.long SCTM2_IRQHandler
	.long SCTM3_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F0008)
	.long PWM0_IRQHandler
	.long PWM1_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F52220_30) || (USE_HT32_CHIP == HT32F52342_52) || (USE_HT32_CHIP == HT32F52344_54)
	.long _RESERVED
	.long _RESERVED
.endif
	.long BFTM0_IRQHandler
.if (USE_HT32_CHIP == HT32F52220_30)
	.long _RESERVED
.else
	.long BFTM1_IRQHandler
.endif
	.long I2C0_IRQHandler
.if (USE_HT32_CHIP == HT32F52220_30) || (USE_HT32_CHIP == HT32F0008) || (USE_HT32_CHIP == HT32F52344_54) || (USE_HT32_CHIP == HT32F0006)
	.long _RESERVED
.else
	.long I2C1_IRQHandler
.endif
	.long SPI0_IRQHandler
.if (USE_HT32_CHIP == HT32F52220_30) || (USE_HT32_CHIP == HT32F0008)
	.long _RESERVED
.else
.if (USE_HT32_CHIP == HT32F0006)
	.long QSPI_IRQHandler
.else
	.long SPI1_IRQHandler
.endif
.endif
.if (USE_HT32_CHIP == HT32F52344_54)
	.long _RESERVED
.else
	.long USART0_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F52342_52) || (USE_HT32_CHIP == HT32F52243_53)
	.long USART1_IRQHandler
.else
	.long _RESERVED
.endif
	.long UART0_IRQHandler
.if (USE_HT32_CHIP == HT32F52220_30) || (USE_HT32_CHIP == HT32F0008) || (USE_HT32_CHIP == HT32F0006)
	.long _RESERVED
.else
	.long UART1_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F52331_41) || (USE_HT32_CHIP == HT32F52342_52)
	.long SCI_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F52243_53)
	.long UART2_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F0006)
	.long MIDI_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F0008) || (USE_HT32_CHIP == HT32F52344_54)
	.long _RESERVED
.endif
.if (USE_HT32_CHIP == HT32F52342_52) || (USE_HT32_CHIP == HT32F0006)
	.long I2S_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F52331_41) || (USE_HT32_CHIP == HT32F52344_54)
	.long _RESERVED
.endif
.if (USE_HT32_CHIP == HT32F52243_53)
	.long UART3_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F0008)
	.long AES_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F52331_41) || (USE_HT32_CHIP == HT32F52342_52) || (USE_HT32_CHIP == HT32F0008) || (USE_HT32_CHIP == HT32F52344_54) || (USE_HT32_CHIP == HT32F0006)
	.long USB_IRQHandler
.endif
.if (USE_HT32_CHIP == HT32F52243_53)
	.long _RESERVED
.endif
.if (USE_HT32_CHIP == HT32F52342_52) || (USE_HT32_CHIP == HT32F52243_53) || (USE_HT32_CHIP == HT32F0008) || (USE_HT32_CHIP == HT32F52344_54) || (USE_HT32_CHIP == HT32F0006)
	.long PDMA_CH0_1_IRQHandler
	.long PDMA_CH2_5_IRQHandler
.endif

@ Reset handler routine
	.type	Reset_Handler, %function
	.thumb_func
Reset_Handler:
	.weak Reset_Handler
	.global Reset_Handler
	.extern SystemInit
	.extern __main
                    LDR     R0, =BootProcess
                    BLX     R0
	.syntax unified
	@ Copy .data section from Flash to SRAM
	LDR	R1, =_sidata
	LDR	R2, =_sdata
	LDR	R3, =_edata
	B	LoopCopyDataInit
	.type	CopyDataInit, %function
	.thumb_func
CopyDataInit:
	LDR	R0, [R1]
	ADDS	R1, R1, #4
	STR	R0, [R2]
	ADDS	R2, R2, #4
	.type	LoopCopyDataInit, %function
	.thumb_func
LoopCopyDataInit:
	CMP	R2, R3
	BCC	CopyDataInit
	@ Zero fill .bss section
	LDR	R2, =_sbss
	LDR	R4, =_ebss
	MOVS	R3, #0
	B	LoopFillZerobss
	.type	FillZerobss, %function
	.thumb_func
FillZerobss:
	STR	R3, [R2]
	ADDS	R2, R2, #4
	.type	LoopFillZerobss, %function
	.thumb_func
LoopFillZerobss:
	CMP	R2, R4
	BCC	FillZerobss
	@ Call the clock system initialization function
	BL	SystemInit
	@ Call C++ static constructors
	BL	__libc_init_array
                    LDR     R0, =main
                    BX      R0

	.type	BootProcess, %function
	.thumb_func
BootProcess:
                    LDR     R0, =0x40080300
                    LDR     R1,[R0, #0x10]
                    CMP     R1, #0
                    BNE     BP1
                    LDR     R1,[R0, #0x14]
                    CMP     R1, #0
                    BNE     BP1
                    LDR     R1,[R0, #0x18]
                    CMP     R1, #0
                    BNE     BP1
                    LDR     R1,[R0, #0x1C]
                    CMP     R1, #0
                    BEQ     BP2
BP1:                 LDR     R0, =0x40080180
                    LDR     R1,[R0, #0xC]
                    LSLS    R1, R1, #4
                    LSRS    R1, R1, #20
                    CMP     R1, #0
                    BEQ     BP3
                    CMP     R1, #5
                    BEQ     BP3
                    CMP     R1, #6
                    BEQ     BP3
BP2:                 DSB
                    LDR     R0, =0x20000000
                    LDR     R1, =0x05fa0004
                    STR     R1, [R0]
                    LDR     R1, =0xe000ed00
                    LDR     R0, =0x05fa0004
                    STR     R0, [R1, #0xC]
                    DSB
                    B       .
BP3:                 LDR     R0, =0x20000000
                    LDR     R1, [R0]
                    LDR     R0, =0x05fa0004
                    CMP     R0, R1
                    BEQ     BP4
                    BX      LR
BP4:                 LDR     R0, =0x40088100
                    LDR     R1, =0x00000001
                    STR     R1, [R0]
                    LDR     R0, =0x20000000
                    LDR     R1, =0x0
                    STR     R1, [R0]
                    BX      LR

@ Dummy Exception Handlers
	.type	NMI_Handler, %function
	.thumb_func
NMI_Handler:
	.weak NMI_Handler
	.global NMI_Handler
                    B       .

	.type	HardFault_Handler, %function
	.thumb_func
HardFault_Handler:
	.weak HardFault_Handler
	.global HardFault_Handler
                    B       .

	.type	SVC_Handler, %function
	.thumb_func
SVC_Handler:
	.weak SVC_Handler
	.global SVC_Handler
                    B       .

	.type	PendSV_Handler, %function
	.thumb_func
PendSV_Handler:
	.weak PendSV_Handler
	.global PendSV_Handler
                    B       .

	.type	SysTick_Handler, %function
	.thumb_func
SysTick_Handler:
	.weak SysTick_Handler
	.global SysTick_Handler
                    B       .

	.type	Default_Handler, %function
	.thumb_func
Default_Handler:
	.weak LVD_BOD_IRQHandler
	.global LVD_BOD_IRQHandler
	.weak RTC_IRQHandler
	.global RTC_IRQHandler
	.weak FLASH_IRQHandler
	.global FLASH_IRQHandler
	.weak EVWUP_IRQHandler
	.global EVWUP_IRQHandler
	.weak EXTI0_1_IRQHandler
	.global EXTI0_1_IRQHandler
	.weak EXTI2_3_IRQHandler
	.global EXTI2_3_IRQHandler
	.weak EXTI4_15_IRQHandler
	.global EXTI4_15_IRQHandler
	.weak COMP_IRQHandler
	.global COMP_IRQHandler
	.weak ADC_IRQHandler
	.global ADC_IRQHandler
	.weak MCTM0_IRQHandler
	.global MCTM0_IRQHandler
	.weak GPTM1_IRQHandler
	.global GPTM1_IRQHandler
	.weak GPTM0_IRQHandler
	.global GPTM0_IRQHandler
	.weak SCTM0_IRQHandler
	.global SCTM0_IRQHandler
	.weak SCTM1_IRQHandler
	.global SCTM1_IRQHandler
	.weak SCTM2_IRQHandler
	.global SCTM2_IRQHandler
	.weak SCTM3_IRQHandler
	.global SCTM3_IRQHandler
	.weak PWM0_IRQHandler
	.global PWM0_IRQHandler
	.weak PWM1_IRQHandler
	.global PWM1_IRQHandler
	.weak BFTM0_IRQHandler
	.global BFTM0_IRQHandler
	.weak BFTM1_IRQHandler
	.global BFTM1_IRQHandler
	.weak I2C0_IRQHandler
	.global I2C0_IRQHandler
	.weak I2C1_IRQHandler
	.global I2C1_IRQHandler
	.weak I2C2_IRQHandler
	.global I2C2_IRQHandler
	.weak SPI0_IRQHandler
	.global SPI0_IRQHandler
	.weak SPI1_IRQHandler
	.global SPI1_IRQHandler
	.weak QSPI_IRQHandler
	.global QSPI_IRQHandler
	.weak USART0_IRQHandler
	.global USART0_IRQHandler
	.weak USART1_IRQHandler
	.global USART1_IRQHandler
	.weak UART0_IRQHandler
	.global UART0_IRQHandler
	.weak UART1_IRQHandler
	.global UART1_IRQHandler
	.weak UART2_IRQHandler
	.global UART2_IRQHandler
	.weak UART3_IRQHandler
	.global UART3_IRQHandler
	.weak SCI_IRQHandler
	.global SCI_IRQHandler
	.weak MIDI_IRQHandler
	.global MIDI_IRQHandler
	.weak I2S_IRQHandler
	.global I2S_IRQHandler
	.weak AES_IRQHandler
	.global AES_IRQHandler
	.weak USB_IRQHandler
	.global USB_IRQHandler
	.weak PDMA_CH0_1_IRQHandler
	.global PDMA_CH0_1_IRQHandler
	.weak PDMA_CH2_5_IRQHandler
	.global PDMA_CH2_5_IRQHandler

	.type	LVD_BOD_IRQHandler, %function
	.thumb_func
LVD_BOD_IRQHandler:
	.type	RTC_IRQHandler, %function
	.thumb_func
RTC_IRQHandler:
	.type	FLASH_IRQHandler, %function
	.thumb_func
FLASH_IRQHandler:
	.type	EVWUP_IRQHandler, %function
	.thumb_func
EVWUP_IRQHandler:
	.type	EXTI0_1_IRQHandler, %function
	.thumb_func
EXTI0_1_IRQHandler:
	.type	EXTI2_3_IRQHandler, %function
	.thumb_func
EXTI2_3_IRQHandler:
	.type	EXTI4_15_IRQHandler, %function
	.thumb_func
EXTI4_15_IRQHandler:
	.type	COMP_IRQHandler, %function
	.thumb_func
COMP_IRQHandler:
	.type	ADC_IRQHandler, %function
	.thumb_func
ADC_IRQHandler:
	.type	MCTM0_IRQHandler, %function
	.thumb_func
MCTM0_IRQHandler:
	.type	GPTM1_IRQHandler, %function
	.thumb_func
GPTM1_IRQHandler:
	.type	GPTM0_IRQHandler, %function
	.thumb_func
GPTM0_IRQHandler:
	.type	SCTM0_IRQHandler, %function
	.thumb_func
SCTM0_IRQHandler:
	.type	SCTM1_IRQHandler, %function
	.thumb_func
SCTM1_IRQHandler:
	.type	SCTM2_IRQHandler, %function
	.thumb_func
SCTM2_IRQHandler:
	.type	SCTM3_IRQHandler, %function
	.thumb_func
SCTM3_IRQHandler:
	.type	PWM0_IRQHandler, %function
	.thumb_func
PWM0_IRQHandler:
	.type	PWM1_IRQHandler, %function
	.thumb_func
PWM1_IRQHandler:
	.type	BFTM0_IRQHandler, %function
	.thumb_func
BFTM0_IRQHandler:
	.type	BFTM1_IRQHandler, %function
	.thumb_func
BFTM1_IRQHandler:
	.type	I2C0_IRQHandler, %function
	.thumb_func
I2C0_IRQHandler:
	.type	I2C1_IRQHandler, %function
	.thumb_func
I2C1_IRQHandler:
	.type	I2C2_IRQHandler, %function
	.thumb_func
I2C2_IRQHandler:
	.type	SPI0_IRQHandler, %function
	.thumb_func
SPI0_IRQHandler:
	.type	SPI1_IRQHandler, %function
	.thumb_func
SPI1_IRQHandler:
	.type	QSPI_IRQHandler, %function
	.thumb_func
QSPI_IRQHandler:
	.type	USART0_IRQHandler, %function
	.thumb_func
USART0_IRQHandler:
	.type	USART1_IRQHandler, %function
	.thumb_func
USART1_IRQHandler:
	.type	UART0_IRQHandler, %function
	.thumb_func
UART0_IRQHandler:
	.type	UART1_IRQHandler, %function
	.thumb_func
UART1_IRQHandler:
	.type	UART2_IRQHandler, %function
	.thumb_func
UART2_IRQHandler:
	.type	UART3_IRQHandler, %function
	.thumb_func
UART3_IRQHandler:
	.type	SCI_IRQHandler, %function
	.thumb_func
SCI_IRQHandler:
	.type	MIDI_IRQHandler, %function
	.thumb_func
MIDI_IRQHandler:
	.type	I2S_IRQHandler, %function
	.thumb_func
I2S_IRQHandler:
	.type	AES_IRQHandler, %function
	.thumb_func
AES_IRQHandler:
	.type	USB_IRQHandler, %function
	.thumb_func
USB_IRQHandler:
	.type	PDMA_CH0_1_IRQHandler, %function
	.thumb_func
PDMA_CH0_1_IRQHandler:
	.type	PDMA_CH2_5_IRQHandler, %function
	.thumb_func
PDMA_CH2_5_IRQHandler:
                    B       .

	.balign 4

@ *******************************************************************************
@ User Stack and Heap initialization
@ *******************************************************************************
	.global __HT_check_heap
	.global __HT_check_sp

	@ [keil2gnu] Keil __MICROLIB block removed (GNU toolchain uses __StackTop/_end)


